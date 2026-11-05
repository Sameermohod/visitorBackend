import { originAllowed } from '../middleware/security';
import { accessSecret } from '../configs/secrets';
import http from 'http';
import jwt from 'jsonwebtoken';
import { Server, Socket } from 'socket.io';
import prisma from '../configs/db';
import logger from '../configs/logger';
import { userCache } from '../middleware/auth';
import { TtlCache } from '../utils/cache';

/**
 * Live connection to the browser (Socket.IO).
 *
 *  - Everyone signs in with the same access token as the REST API; the server decides which private rooms they join.
 *    A browser can never ask to join somebody else's room.
 *  - Rooms:  u:<userId>  (one person, all their devices)   t:<tenantId>  (one society)
 *            r:<tenantId>:<role>  (one role in one society, e.g. all Security Guards)
 *  - Data never travels in a "something changed" signal, only the name of the thing. The screen then reloads through the
 *    normal REST API, so permissions are checked exactly as before.
 *  - This runs in one server process. To run several copies, add the Socket.IO Redis adapter (see REALTIME.md).
 */

let io: Server | null = null;

const secret = () => accessSecret();

export const userRoom = (userId: string) => `u:${userId}`;
export const tenantRoom = (tenantId: string) => `t:${tenantId}`;
export const roleRoom = (tenantId: string, role: string) => `r:${tenantId}:${role}`;

// userId -> number of open connections (a person may have the app open on a phone and a laptop)
const connections = new Map<string, number>();
export const isOnline = (userId: string) => (connections.get(userId) ?? 0) > 0;

interface SocketUser { id: string; tenantId: string | null; role: string; name: string }
const socketUser = (s: Socket) => s.data.user as SocketUser;

export const emitToUsers = (userIds: string[], event: string, payload: unknown) => {
  if (!io || !userIds.length) return;
  io.to([...new Set(userIds)].map(userRoom)).emit(event, payload);
};

export const emitToRoles = (tenantId: string, roles: string[], event: string, payload: unknown) => {
  if (!io || !roles.length) return;
  io.to(roles.map((r) => roleRoom(tenantId, r))).emit(event, payload);
};

export const emitToTenant = (tenantId: string, event: string, payload: unknown) => {
  io?.to(tenantRoom(tenantId)).emit(event, payload);
};

// "Is this person in this conversation?" is asked for every typing signal, so remember answers briefly
const memberCache = new TtlCache<string[]>(60_000, 5_000);

export const initRealtime = (server: http.Server) => {
  io = new Server(server, {
    // Same website allow-list as the REST API; native apps send no Origin
    cors: { origin: (origin, cb) => cb(null, originAllowed(origin)), methods: ['GET', 'POST'] },
    // Pings keep phones that lose signal from looking "online" for long
    pingInterval: 20_000,
    pingTimeout: 20_000,
    maxHttpBufferSize: 20_000, // a typing signal is tiny; messages travel over REST
  });

  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      if (typeof token !== 'string' || !token) return next(new Error('Sign in required'));
      const decoded = jwt.verify(token, secret()) as { userId: string; type?: string; typ?: string };
      if (typeof decoded.userId !== 'string' || decoded.type === 'mcp' || decoded.typ) return next(new Error('Sign in required'));

      let user = userCache.get(decoded.userId);
      if (!user) {
        const found = await prisma.user.findFirst({
          where: { id: decoded.userId, deletedAt: null },
          select: { id: true, tenantId: true, role: { select: { name: true } } },
        });
        if (!found) return next(new Error('Sign in required'));
        socket.data.user = { id: found.id, tenantId: found.tenantId, role: found.role.name, name: '' } as SocketUser;
        return next();
      }
      socket.data.user = { id: user.id, tenantId: user.tenantId, role: user.roleName, name: `${user.firstName} ${user.lastName}`.trim() } as SocketUser;
      next();
    } catch {
      next(new Error('Sign in required'));
    }
  });

  io.on('connection', (socket) => {
    const u = socketUser(socket);
    socket.join(userRoom(u.id));
    if (u.tenantId) {
      socket.join(tenantRoom(u.tenantId));
      socket.join(roleRoom(u.tenantId, u.role));
    }
    connections.set(u.id, (connections.get(u.id) ?? 0) + 1);

    // Typing signal for a direct conversation: forwarded only to the other person, only if this person is in it
    socket.on('typing', async (data: { conversationId?: string }) => {
      try {
        const id = data?.conversationId;
        if (typeof id !== 'string' || !u.tenantId) return;
        let ids = memberCache.get(id);
        if (!ids) {
          const convo = await prisma.conversation.findFirst({
            where: { id, tenantId: u.tenantId, kind: 'DIRECT' },
            select: { members: { select: { userId: true } } },
          });
          ids = convo ? convo.members.map((m) => m.userId) : [];
          memberCache.set(id, ids);
        }
        if (!ids.includes(u.id)) return;
        emitToUsers(ids.filter((x) => x !== u.id), 'typing', { conversationId: id, userId: u.id, name: u.name });
      } catch {
        /* a lost typing signal is harmless */
      }
    });

    // Which of these people are online right now? Only people in the same society can be asked about.
    socket.on('presence', async (data: { userIds?: string[] }, ack?: (online: string[]) => void) => {
      if (typeof ack !== 'function' || !Array.isArray(data?.userIds) || !u.tenantId) return;
      const ids = data.userIds.filter((x) => typeof x === 'string').slice(0, 100);
      const same = await prisma.user.findMany({ where: { id: { in: ids }, tenantId: u.tenantId, deletedAt: null }, select: { id: true } });
      ack(same.map((x) => x.id).filter(isOnline));
    });

    socket.on('disconnect', () => {
      const left = (connections.get(u.id) ?? 1) - 1;
      if (left <= 0) connections.delete(u.id);
      else connections.set(u.id, left);
    });
  });

  logger.info('Realtime: Socket.IO ready');
  return io;
};

export const forgetConversationMembers = (conversationId: string) => memberCache.invalidate(conversationId);
