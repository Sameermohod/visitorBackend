"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.forgetConversationMembers = exports.initRealtime = exports.emitToTenant = exports.emitToRoles = exports.emitToUsers = exports.isOnline = exports.roleRoom = exports.tenantRoom = exports.userRoom = void 0;
const security_1 = require("../middleware/security");
const secrets_1 = require("../configs/secrets");
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const socket_io_1 = require("socket.io");
const db_1 = __importDefault(require("../configs/db"));
const logger_1 = __importDefault(require("../configs/logger"));
const auth_1 = require("../middleware/auth");
const cache_1 = require("../utils/cache");
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
let io = null;
const secret = () => (0, secrets_1.accessSecret)();
const userRoom = (userId) => `u:${userId}`;
exports.userRoom = userRoom;
const tenantRoom = (tenantId) => `t:${tenantId}`;
exports.tenantRoom = tenantRoom;
const roleRoom = (tenantId, role) => `r:${tenantId}:${role}`;
exports.roleRoom = roleRoom;
// userId -> number of open connections (a person may have the app open on a phone and a laptop)
const connections = new Map();
const isOnline = (userId) => (connections.get(userId) ?? 0) > 0;
exports.isOnline = isOnline;
const socketUser = (s) => s.data.user;
const emitToUsers = (userIds, event, payload) => {
    if (!io || !userIds.length)
        return;
    io.to([...new Set(userIds)].map(exports.userRoom)).emit(event, payload);
};
exports.emitToUsers = emitToUsers;
const emitToRoles = (tenantId, roles, event, payload) => {
    if (!io || !roles.length)
        return;
    io.to(roles.map((r) => (0, exports.roleRoom)(tenantId, r))).emit(event, payload);
};
exports.emitToRoles = emitToRoles;
const emitToTenant = (tenantId, event, payload) => {
    io?.to((0, exports.tenantRoom)(tenantId)).emit(event, payload);
};
exports.emitToTenant = emitToTenant;
// "Is this person in this conversation?" is asked for every typing signal, so remember answers briefly
const memberCache = new cache_1.TtlCache(60_000, 5_000);
const initRealtime = (server) => {
    io = new socket_io_1.Server(server, {
        // Same website allow-list as the REST API; native apps send no Origin
        cors: { origin: (origin, cb) => cb(null, (0, security_1.originAllowed)(origin)), methods: ['GET', 'POST'] },
        // Pings keep phones that lose signal from looking "online" for long
        pingInterval: 20_000,
        pingTimeout: 20_000,
        maxHttpBufferSize: 20_000, // a typing signal is tiny; messages travel over REST
    });
    io.use(async (socket, next) => {
        try {
            const token = socket.handshake.auth?.token;
            if (typeof token !== 'string' || !token)
                return next(new Error('Sign in required'));
            const decoded = jsonwebtoken_1.default.verify(token, secret());
            if (typeof decoded.userId !== 'string' || decoded.type === 'mcp' || decoded.typ)
                return next(new Error('Sign in required'));
            let user = auth_1.userCache.get(decoded.userId);
            if (!user) {
                const found = await db_1.default.user.findFirst({
                    where: { id: decoded.userId, deletedAt: null },
                    select: { id: true, tenantId: true, role: { select: { name: true } } },
                });
                if (!found)
                    return next(new Error('Sign in required'));
                socket.data.user = { id: found.id, tenantId: found.tenantId, role: found.role.name, name: '' };
                return next();
            }
            socket.data.user = { id: user.id, tenantId: user.tenantId, role: user.roleName, name: `${user.firstName} ${user.lastName}`.trim() };
            next();
        }
        catch {
            next(new Error('Sign in required'));
        }
    });
    io.on('connection', (socket) => {
        const u = socketUser(socket);
        socket.join((0, exports.userRoom)(u.id));
        if (u.tenantId) {
            socket.join((0, exports.tenantRoom)(u.tenantId));
            socket.join((0, exports.roleRoom)(u.tenantId, u.role));
        }
        connections.set(u.id, (connections.get(u.id) ?? 0) + 1);
        // Typing signal for a direct conversation: forwarded only to the other person, only if this person is in it
        socket.on('typing', async (data) => {
            try {
                const id = data?.conversationId;
                if (typeof id !== 'string' || !u.tenantId)
                    return;
                let ids = memberCache.get(id);
                if (!ids) {
                    const convo = await db_1.default.conversation.findFirst({
                        where: { id, tenantId: u.tenantId, kind: 'DIRECT' },
                        select: { members: { select: { userId: true } } },
                    });
                    ids = convo ? convo.members.map((m) => m.userId) : [];
                    memberCache.set(id, ids);
                }
                if (!ids.includes(u.id))
                    return;
                (0, exports.emitToUsers)(ids.filter((x) => x !== u.id), 'typing', { conversationId: id, userId: u.id, name: u.name });
            }
            catch {
                /* a lost typing signal is harmless */
            }
        });
        // Which of these people are online right now? Only people in the same society can be asked about.
        socket.on('presence', async (data, ack) => {
            if (typeof ack !== 'function' || !Array.isArray(data?.userIds) || !u.tenantId)
                return;
            const ids = data.userIds.filter((x) => typeof x === 'string').slice(0, 100);
            const same = await db_1.default.user.findMany({ where: { id: { in: ids }, tenantId: u.tenantId, deletedAt: null }, select: { id: true } });
            ack(same.map((x) => x.id).filter(exports.isOnline));
        });
        socket.on('disconnect', () => {
            const left = (connections.get(u.id) ?? 1) - 1;
            if (left <= 0)
                connections.delete(u.id);
            else
                connections.set(u.id, left);
        });
    });
    logger_1.default.info('Realtime: Socket.IO ready');
    return io;
};
exports.initRealtime = initRealtime;
const forgetConversationMembers = (conversationId) => memberCache.invalidate(conversationId);
exports.forgetConversationMembers = forgetConversationMembers;
