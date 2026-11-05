import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import prisma from '../../configs/db';
import ApiResponse from '../../utils/apiResponse';
import { emitToRoles, emitToUsers, isOnline } from '../../realtime/hub';
import { notifyUsers } from '../../services/payments';
import { COMMUNITY_KEY, COMMUNITY_ROLES, OFFICE_ROLES, canMessage, directKey, reachableRoles } from './messages.rules';

const sendSchema = z.object({ body: z.string().trim().min(1, 'Type a message first.').max(2000, 'Messages can be up to 2000 characters.') });

// At most this many messages per person per minute, so nobody can flood the society
const SEND_LIMIT = 20;
const sentAt = new Map<string, number[]>();
const allowedToSend = (userId: string) => {
  const now = Date.now();
  const recent = (sentAt.get(userId) ?? []).filter((t) => now - t < 60_000);
  if (recent.length >= SEND_LIMIT) {
    sentAt.set(userId, recent);
    return false;
  }
  recent.push(now);
  sentAt.set(userId, recent);
  return true;
};

const personSelect = { id: true, firstName: true, lastName: true, role: { select: { name: true } } } as const;
const fullName = (u: { firstName: string; lastName: string }) => `${u.firstName} ${u.lastName}`.trim();

const publicMessage = (m: {
  id: string; conversationId: string; senderId: string; body: string; createdAt: Date; deletedAt: Date | null;
  sender: { id: string; firstName: string; lastName: string; role: { name: string } };
}) => ({
  id: m.id,
  conversationId: m.conversationId,
  senderId: m.senderId,
  senderName: fullName(m.sender),
  senderRole: m.sender.role.name,
  body: m.deletedAt ? '' : m.body,
  deleted: !!m.deletedAt,
  createdAt: m.createdAt,
});

const needSociety = (req: Request, res: Response) => {
  if (!req.tenantId || !req.user?.tenantId || req.user.role === 'Super Admin') {
    ApiResponse.error(res, 'Messaging is available inside a society.', null, 403);
    return false;
  }
  return true;
};

/** The society's single community channel (created the first time anyone needs it). */
const communityConversation = async (tenantId: string) =>
  prisma.conversation.upsert({
    where: { tenantId_directKey: { tenantId, directKey: COMMUNITY_KEY } },
    update: {},
    create: { tenantId, kind: 'COMMUNITY', directKey: COMMUNITY_KEY, title: 'Society community' },
  });

/**
 * A conversation this person is allowed to open (or null), plus the other person in a one-to-one chat.
 * The three lookups run together, so this costs one round trip to the database, not three.
 */
const openConversation = async (req: Request, id: string) => {
  const tenantId = req.tenantId!;
  const me = req.user!;
  const [convo, mine, others] = await Promise.all([
    prisma.conversation.findFirst({ where: { id, tenantId } }),
    prisma.conversationMember.findUnique({ where: { conversationId_userId: { conversationId: id, userId: me.id } }, select: { id: true } }),
    prisma.conversationMember.findMany({
      where: { conversationId: id, userId: { not: me.id } },
      select: { lastReadAt: true, user: { select: { id: true, deletedAt: true, role: { select: { name: true } } } } },
      take: 1,
    }),
  ]);
  if (!convo) return null;
  if (convo.kind === 'COMMUNITY') {
    if (!COMMUNITY_ROLES.includes(me.role)) return null;
    if (!mine) await prisma.conversationMember.create({ data: { conversationId: id, userId: me.id } }).catch(() => undefined);
    return { convo, other: null };
  }
  if (!mine) return null;
  return { convo, other: others[0] ?? null };
};

/** Unread messages per conversation for one person. */
const unreadByConversation = async (tenantId: string, userId: string) => {
  const rows = await prisma.$queryRaw<{ conversation_id: string; n: number }[]>`
    SELECT m.conversation_id, COUNT(*)::int AS n
    FROM messages m
    JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = ${userId}::uuid
    WHERE m.tenant_id = ${tenantId}::uuid AND m.sender_id <> ${userId}::uuid AND m.deleted_at IS NULL AND m.created_at > cm.last_read_at
    GROUP BY m.conversation_id`;
  return new Map(rows.map((r) => [r.conversation_id, r.n]));
};

/** Everyone who should see a new message / deletion on this conversation right now. */
const broadcast = async (tenantId: string, convo: { id: string; kind: string }, event: string, payload: unknown) => {
  if (convo.kind === 'COMMUNITY') {
    emitToRoles(tenantId, COMMUNITY_ROLES, event, payload);
    return;
  }
  const members = await prisma.conversationMember.findMany({ where: { conversationId: convo.id }, select: { userId: true } });
  emitToUsers(members.map((m) => m.userId), event, payload);
};

export class MessagesController {
  /** My conversations, newest first, with unread counts. */
  static async list(req: Request, res: Response, next: NextFunction) {
    try {
      if (!needSociety(req, res)) return;
      const tenantId = req.tenantId!;
      const me = req.user!;

      const load = () => Promise.all([
        prisma.conversationMember.findMany({
          where: { userId: me.id, conversation: { tenantId } },
          select: { conversation: { select: { id: true, kind: true, title: true, lastMessageAt: true, lastMessagePreview: true } } },
          orderBy: { conversation: { lastMessageAt: 'desc' } },
          take: 80,
        }),
        unreadByConversation(tenantId, me.id),
      ]);
      let [memberships, unread] = await load();

      // First time in the community channel: create it if needed and join (rare, so the common path stays one round trip)
      if (COMMUNITY_ROLES.includes(me.role) && !memberships.some((m) => m.conversation.kind === 'COMMUNITY')) {
        const community = await communityConversation(tenantId);
        await prisma.conversationMember.create({ data: { conversationId: community.id, userId: me.id } }).catch(() => undefined);
        [memberships, unread] = await load();
      }

      const directIds = memberships.filter((m) => m.conversation.kind === 'DIRECT').map((m) => m.conversation.id);
      const others = directIds.length
        ? await prisma.conversationMember.findMany({
            where: { conversationId: { in: directIds }, userId: { not: me.id } },
            select: { conversationId: true, user: { select: personSelect } },
          })
        : [];
      const otherOf = new Map(others.map((o) => [o.conversationId, o.user]));

      const items = memberships.map(({ conversation: c }) => {
        const other = otherOf.get(c.id);
        return {
          id: c.id,
          kind: c.kind,
          title: c.kind === 'COMMUNITY' ? c.title : other ? fullName(other) : 'Former member',
          role: other?.role.name ?? null,
          otherUserId: other?.id ?? null,
          online: other ? isOnline(other.id) : false,
          lastMessageAt: c.lastMessageAt,
          lastMessagePreview: c.lastMessagePreview,
          unread: unread.get(c.id) ?? 0,
        };
      });
      // The community channel is always at the top; the rest by latest message
      items.sort((a, b) => (a.kind === b.kind ? +new Date(b.lastMessageAt) - +new Date(a.lastMessageAt) : a.kind === 'COMMUNITY' ? -1 : 1));

      const total = items.reduce((n, i) => n + i.unread, 0);
      return ApiResponse.success(res, { items, unread: total }, 'Conversations loaded');
    } catch (error) {
      next(error);
    }
  }

  /** Total unread, for the badge in the menu. */
  static async unread(req: Request, res: Response, next: NextFunction) {
    try {
      if (!req.tenantId || !req.user?.tenantId || req.user.role === 'Super Admin') return ApiResponse.success(res, { unread: 0 }, 'OK');
      const map = await unreadByConversation(req.tenantId, req.user.id);
      let unread = 0;
      map.forEach((n) => { unread += n; });
      return ApiResponse.success(res, { unread }, 'Unread loaded');
    } catch (error) {
      next(error);
    }
  }

  /** People this person may start a conversation with (names and roles only, no contact details). */
  static async people(req: Request, res: Response, next: NextFunction) {
    try {
      if (!needSociety(req, res)) return;
      const tenantId = req.tenantId!;
      const me = req.user!;
      const q = String(req.query.q ?? '').trim();
      const roles = reachableRoles(me.role);

      const linked = await prisma.tenancy.findMany({
        where: { tenantId, status: 'ACTIVE', OR: [{ ownerUserId: me.id }, { renterUserId: me.id }] },
        select: { ownerUserId: true, renterUserId: true },
      });
      const linkedIds = linked.flatMap((t) => [t.ownerUserId, t.renterUserId]).filter((x): x is string => !!x && x !== me.id);

      // Residents are only listed when searched for, so a big society's directory is not handed out in one go
      const where: any = {
        tenantId, deletedAt: null, id: { not: me.id },
        role: { name: { not: 'Super Admin' } },
        AND: [
          roles === null
            ? {}
            : q.length >= 2
              ? { OR: [{ role: { name: { in: roles } } }, { id: { in: linkedIds } }] }
              : { OR: [{ role: { name: { in: OFFICE_ROLES } } }, { id: { in: linkedIds } }] },
          q ? { OR: [{ firstName: { contains: q, mode: 'insensitive' } }, { lastName: { contains: q, mode: 'insensitive' } }] } : {},
        ],
      };

      const users = await prisma.user.findMany({
        where,
        select: { ...personSelect, residents: { where: { deletedAt: null }, select: { flat: { select: { number: true } } }, take: 1 } },
        orderBy: [{ firstName: 'asc' }],
        take: 30,
      });
      const items = users
        .map((u) => ({ id: u.id, name: fullName(u), role: u.role.name, flat: u.residents[0]?.flat?.number ?? null, online: isOnline(u.id) }))
        .sort((a, b) => Number(OFFICE_ROLES.includes(b.role)) - Number(OFFICE_ROLES.includes(a.role)));
      return ApiResponse.success(res, items, 'People loaded');
    } catch (error) {
      next(error);
    }
  }

  /** Open (or create) the one-to-one conversation with someone. */
  static async startDirect(req: Request, res: Response, next: NextFunction) {
    try {
      if (!needSociety(req, res)) return;
      const tenantId = req.tenantId!;
      const me = req.user!;
      const { userId } = z.object({ userId: z.string().uuid() }).parse(req.body);

      if (req.user!.messagingDisabled) return ApiResponse.error(res, 'Messaging has been turned off for your account by the society office.', null, 403);

      const target = await prisma.user.findFirst({ where: { id: userId, tenantId, deletedAt: null }, select: personSelect });
      if (!target || !(await canMessage(tenantId, { id: me.id, role: me.role }, { id: target.id, role: target.role.name }))) {
        return ApiResponse.error(res, 'You cannot message this person.', null, 403);
      }

      const key = directKey(me.id, target.id);
      const find = () => prisma.conversation.findUnique({ where: { tenantId_directKey: { tenantId, directKey: key } } });
      let convo = await find();
      if (!convo) {
        try {
          convo = await prisma.conversation.create({
            data: { tenantId, kind: 'DIRECT', directKey: key, members: { create: [{ userId: me.id }, { userId: target.id }] } },
          });
        } catch (e: any) {
          if (e?.code !== 'P2002') throw e;
          convo = await find(); // both people opened it at the same moment
        }
      }
      return ApiResponse.success(res, { id: convo!.id }, 'Conversation ready');
    } catch (error) {
      next(error);
    }
  }

  /** A page of messages, oldest first. Pass `before` (a message time) to load older ones. */
  static async history(req: Request, res: Response, next: NextFunction) {
    try {
      if (!needSociety(req, res)) return;
      const opened = await openConversation(req, req.params.id);
      if (!opened) return ApiResponse.error(res, 'Conversation not found.', null, 404);
      const { convo, other } = opened;

      const limit = Math.min(Number(req.query.limit) || 30, 60);
      const before = req.query.before ? new Date(String(req.query.before)) : null;
      if (before && Number.isNaN(+before)) return ApiResponse.error(res, 'Invalid "before" time.', null, 400);

      const rows = await prisma.message.findMany({
        relationLoadStrategy: 'join',
        where: { conversationId: convo.id, ...(before ? { createdAt: { lt: before } } : {}) },
        orderBy: { createdAt: 'desc' },
        take: limit + 1,
        include: { sender: { select: personSelect } },
      });
      const hasMore = rows.length > limit;
      const messages = rows.slice(0, limit).reverse().map(publicMessage);

      // For a one-to-one chat: when did the other person last read it (for the "Seen" tick)
      return ApiResponse.success(res, { messages, hasMore, otherReadAt: other?.lastReadAt ?? null }, 'Messages loaded');
    } catch (error) {
      next(error);
    }
  }

  static async send(req: Request, res: Response, next: NextFunction) {
    try {
      if (!needSociety(req, res)) return;
      const tenantId = req.tenantId!;
      const me = req.user!;
      const { body } = sendSchema.parse(req.body);

      if (me.messagingDisabled) return ApiResponse.error(res, 'Messaging has been turned off for your account by the society office.', null, 403);
      if (!allowedToSend(me.id)) return ApiResponse.error(res, 'You are sending messages very quickly. Please wait a moment.', null, 429);

      const opened = await openConversation(req, req.params.id);
      if (!opened) return ApiResponse.error(res, 'Conversation not found.', null, 404);
      const { convo, other } = opened;

      let otherId: string | null = null;
      if (convo.kind === 'DIRECT') {
        if (!other || other.user.deletedAt || !(await canMessage(tenantId, { id: me.id, role: me.role }, { id: other.user.id, role: other.user.role.name }))) {
          return ApiResponse.error(res, 'You can no longer message this person.', null, 403);
        }
        otherId = other.user.id;
      }

      // The three writes are independent, so they go out together
      const now = new Date();
      const [message] = await Promise.all([
        prisma.message.create({
          data: { tenantId, conversationId: convo.id, senderId: me.id, body },
          include: { sender: { select: personSelect } },
        }),
        prisma.conversation.update({ where: { id: convo.id }, data: { lastMessageAt: now, lastMessagePreview: body.slice(0, 140) } }),
        // Sending counts as having read everything before it
        prisma.conversationMember.updateMany({ where: { conversationId: convo.id, userId: me.id }, data: { lastReadAt: now } }),
      ]);

      const payload = { kind: convo.kind, title: convo.title, message: publicMessage(message) };
      if (convo.kind === 'COMMUNITY') emitToRoles(tenantId, COMMUNITY_ROLES, 'message:new', payload);
      else emitToUsers([me.id, otherId!], 'message:new', payload);

      // Someone with the app closed gets one bell notification, not one per message
      if (otherId && !isOnline(otherId)) {
        const title = `New message from ${fullName(message.sender)}`;
        const recent = await prisma.notification.findFirst({
          where: { userId: otherId, type: 'MESSAGE', title, isRead: false, createdAt: { gt: new Date(Date.now() - 30 * 60_000) } },
          select: { id: true },
        });
        if (!recent) await notifyUsers(tenantId, [otherId], title, body.slice(0, 120), 'MESSAGE');
      }

      return ApiResponse.success(res, payload.message, 'Sent', 201);
    } catch (error) {
      next(error);
    }
  }

  /** Mark the conversation as read up to now. */
  static async markRead(req: Request, res: Response, next: NextFunction) {
    try {
      if (!needSociety(req, res)) return;
      const me = req.user!;
      const opened = await openConversation(req, req.params.id);
      if (!opened) return ApiResponse.error(res, 'Conversation not found.', null, 404);
      const { convo, other } = opened;

      const at = new Date();
      await prisma.conversationMember.updateMany({ where: { conversationId: convo.id, userId: me.id }, data: { lastReadAt: at } });

      emitToUsers([me.id], 'message:seen', { conversationId: convo.id }); // clears the badge on my other devices
      if (other) emitToUsers([other.user.id], 'message:read', { conversationId: convo.id, at });
      return ApiResponse.success(res, null, 'Marked as read');
    } catch (error) {
      next(error);
    }
  }

  /** Delete a message: the sender can delete their own; the office can remove anything in the community channel. */
  static async remove(req: Request, res: Response, next: NextFunction) {
    try {
      if (!needSociety(req, res)) return;
      const tenantId = req.tenantId!;
      const me = req.user!;
      const msg = await prisma.message.findFirst({ where: { id: req.params.id, tenantId, deletedAt: null }, include: { conversation: true } });
      if (!msg) return ApiResponse.error(res, 'Message not found.', null, 404);

      const opened = await openConversation(req, msg.conversationId);
      const convo = opened?.convo;
      const isOffice = OFFICE_ROLES.includes(me.role);
      if (!convo || !(msg.senderId === me.id || (isOffice && convo.kind === 'COMMUNITY'))) {
        return ApiResponse.error(res, 'You cannot delete this message.', null, 403);
      }

      await prisma.message.update({ where: { id: msg.id }, data: { deletedAt: new Date(), deletedBy: me.id } });
      await broadcast(tenantId, convo!, 'message:deleted', { conversationId: convo!.id, messageId: msg.id });
      return ApiResponse.success(res, null, 'Message deleted');
    } catch (error) {
      next(error);
    }
  }
}
