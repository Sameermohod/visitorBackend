"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.MessagesController = void 0;
const zod_1 = require("zod");
const db_1 = __importDefault(require("../../configs/db"));
const apiResponse_1 = __importDefault(require("../../utils/apiResponse"));
const hub_1 = require("../../realtime/hub");
const payments_1 = require("../../services/payments");
const messages_rules_1 = require("./messages.rules");
const sendSchema = zod_1.z.object({ body: zod_1.z.string().trim().min(1, 'Type a message first.').max(2000, 'Messages can be up to 2000 characters.') });
// At most this many messages per person per minute, so nobody can flood the society
const SEND_LIMIT = 20;
const sentAt = new Map();
const allowedToSend = (userId) => {
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
const personSelect = { id: true, firstName: true, lastName: true, role: { select: { name: true } } };
const fullName = (u) => `${u.firstName} ${u.lastName}`.trim();
const publicMessage = (m) => ({
    id: m.id,
    conversationId: m.conversationId,
    senderId: m.senderId,
    senderName: fullName(m.sender),
    senderRole: m.sender.role.name,
    body: m.deletedAt ? '' : m.body,
    deleted: !!m.deletedAt,
    createdAt: m.createdAt,
});
const needSociety = (req, res) => {
    if (!req.tenantId || !req.user?.tenantId || req.user.role === 'Super Admin') {
        apiResponse_1.default.error(res, 'Messaging is available inside a society.', null, 403);
        return false;
    }
    return true;
};
/** The society's single community channel (created the first time anyone needs it). */
const communityConversation = async (tenantId) => db_1.default.conversation.upsert({
    where: { tenantId_directKey: { tenantId, directKey: messages_rules_1.COMMUNITY_KEY } },
    update: {},
    create: { tenantId, kind: 'COMMUNITY', directKey: messages_rules_1.COMMUNITY_KEY, title: 'Society community' },
});
/**
 * A conversation this person is allowed to open (or null), plus the other person in a one-to-one chat.
 * The three lookups run together, so this costs one round trip to the database, not three.
 */
const openConversation = async (req, id) => {
    const tenantId = req.tenantId;
    const me = req.user;
    const [convo, mine, others] = await Promise.all([
        db_1.default.conversation.findFirst({ where: { id, tenantId } }),
        db_1.default.conversationMember.findUnique({ where: { conversationId_userId: { conversationId: id, userId: me.id } }, select: { id: true } }),
        db_1.default.conversationMember.findMany({
            where: { conversationId: id, userId: { not: me.id } },
            select: { lastReadAt: true, user: { select: { id: true, deletedAt: true, role: { select: { name: true } } } } },
            take: 1,
        }),
    ]);
    if (!convo)
        return null;
    if (convo.kind === 'COMMUNITY') {
        if (!messages_rules_1.COMMUNITY_ROLES.includes(me.role))
            return null;
        if (!mine)
            await db_1.default.conversationMember.create({ data: { conversationId: id, userId: me.id } }).catch(() => undefined);
        return { convo, other: null };
    }
    if (!mine)
        return null;
    return { convo, other: others[0] ?? null };
};
/** Unread messages per conversation for one person. */
const unreadByConversation = async (tenantId, userId) => {
    const rows = await db_1.default.$queryRaw `
    SELECT m.conversation_id, COUNT(*)::int AS n
    FROM messages m
    JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = ${userId}::uuid
    WHERE m.tenant_id = ${tenantId}::uuid AND m.sender_id <> ${userId}::uuid AND m.deleted_at IS NULL AND m.created_at > cm.last_read_at
    GROUP BY m.conversation_id`;
    return new Map(rows.map((r) => [r.conversation_id, r.n]));
};
/** Everyone who should see a new message / deletion on this conversation right now. */
const broadcast = async (tenantId, convo, event, payload) => {
    if (convo.kind === 'COMMUNITY') {
        (0, hub_1.emitToRoles)(tenantId, messages_rules_1.COMMUNITY_ROLES, event, payload);
        return;
    }
    const members = await db_1.default.conversationMember.findMany({ where: { conversationId: convo.id }, select: { userId: true } });
    (0, hub_1.emitToUsers)(members.map((m) => m.userId), event, payload);
};
class MessagesController {
    /** My conversations, newest first, with unread counts. */
    static async list(req, res, next) {
        try {
            if (!needSociety(req, res))
                return;
            const tenantId = req.tenantId;
            const me = req.user;
            const load = () => Promise.all([
                db_1.default.conversationMember.findMany({
                    where: { userId: me.id, conversation: { tenantId } },
                    select: { conversation: { select: { id: true, kind: true, title: true, lastMessageAt: true, lastMessagePreview: true } } },
                    orderBy: { conversation: { lastMessageAt: 'desc' } },
                    take: 80,
                }),
                unreadByConversation(tenantId, me.id),
            ]);
            let [memberships, unread] = await load();
            // First time in the community channel: create it if needed and join (rare, so the common path stays one round trip)
            if (messages_rules_1.COMMUNITY_ROLES.includes(me.role) && !memberships.some((m) => m.conversation.kind === 'COMMUNITY')) {
                const community = await communityConversation(tenantId);
                await db_1.default.conversationMember.create({ data: { conversationId: community.id, userId: me.id } }).catch(() => undefined);
                [memberships, unread] = await load();
            }
            const directIds = memberships.filter((m) => m.conversation.kind === 'DIRECT').map((m) => m.conversation.id);
            const others = directIds.length
                ? await db_1.default.conversationMember.findMany({
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
                    online: other ? (0, hub_1.isOnline)(other.id) : false,
                    lastMessageAt: c.lastMessageAt,
                    lastMessagePreview: c.lastMessagePreview,
                    unread: unread.get(c.id) ?? 0,
                };
            });
            // The community channel is always at the top; the rest by latest message
            items.sort((a, b) => (a.kind === b.kind ? +new Date(b.lastMessageAt) - +new Date(a.lastMessageAt) : a.kind === 'COMMUNITY' ? -1 : 1));
            const total = items.reduce((n, i) => n + i.unread, 0);
            return apiResponse_1.default.success(res, { items, unread: total }, 'Conversations loaded');
        }
        catch (error) {
            next(error);
        }
    }
    /** Total unread, for the badge in the menu. */
    static async unread(req, res, next) {
        try {
            if (!req.tenantId || !req.user?.tenantId || req.user.role === 'Super Admin')
                return apiResponse_1.default.success(res, { unread: 0 }, 'OK');
            const map = await unreadByConversation(req.tenantId, req.user.id);
            let unread = 0;
            map.forEach((n) => { unread += n; });
            return apiResponse_1.default.success(res, { unread }, 'Unread loaded');
        }
        catch (error) {
            next(error);
        }
    }
    /** People this person may start a conversation with (names and roles only, no contact details). */
    static async people(req, res, next) {
        try {
            if (!needSociety(req, res))
                return;
            const tenantId = req.tenantId;
            const me = req.user;
            const q = String(req.query.q ?? '').trim();
            const roles = (0, messages_rules_1.reachableRoles)(me.role);
            const linked = await db_1.default.tenancy.findMany({
                where: { tenantId, status: 'ACTIVE', OR: [{ ownerUserId: me.id }, { renterUserId: me.id }] },
                select: { ownerUserId: true, renterUserId: true },
            });
            const linkedIds = linked.flatMap((t) => [t.ownerUserId, t.renterUserId]).filter((x) => !!x && x !== me.id);
            // Residents are only listed when searched for, so a big society's directory is not handed out in one go
            const where = {
                tenantId, deletedAt: null, id: { not: me.id },
                role: { name: { not: 'Super Admin' } },
                AND: [
                    roles === null
                        ? {}
                        : q.length >= 2
                            ? { OR: [{ role: { name: { in: roles } } }, { id: { in: linkedIds } }] }
                            : { OR: [{ role: { name: { in: messages_rules_1.OFFICE_ROLES } } }, { id: { in: linkedIds } }] },
                    q ? { OR: [{ firstName: { contains: q, mode: 'insensitive' } }, { lastName: { contains: q, mode: 'insensitive' } }] } : {},
                ],
            };
            const users = await db_1.default.user.findMany({
                where,
                select: { ...personSelect, residents: { where: { deletedAt: null }, select: { flat: { select: { number: true } } }, take: 1 } },
                orderBy: [{ firstName: 'asc' }],
                take: 30,
            });
            const items = users
                .map((u) => ({ id: u.id, name: fullName(u), role: u.role.name, flat: u.residents[0]?.flat?.number ?? null, online: (0, hub_1.isOnline)(u.id) }))
                .sort((a, b) => Number(messages_rules_1.OFFICE_ROLES.includes(b.role)) - Number(messages_rules_1.OFFICE_ROLES.includes(a.role)));
            return apiResponse_1.default.success(res, items, 'People loaded');
        }
        catch (error) {
            next(error);
        }
    }
    /** Open (or create) the one-to-one conversation with someone. */
    static async startDirect(req, res, next) {
        try {
            if (!needSociety(req, res))
                return;
            const tenantId = req.tenantId;
            const me = req.user;
            const { userId } = zod_1.z.object({ userId: zod_1.z.string().uuid() }).parse(req.body);
            if (req.user.messagingDisabled)
                return apiResponse_1.default.error(res, 'Messaging has been turned off for your account by the society office.', null, 403);
            const target = await db_1.default.user.findFirst({ where: { id: userId, tenantId, deletedAt: null }, select: personSelect });
            if (!target || !(await (0, messages_rules_1.canMessage)(tenantId, { id: me.id, role: me.role }, { id: target.id, role: target.role.name }))) {
                return apiResponse_1.default.error(res, 'You cannot message this person.', null, 403);
            }
            const key = (0, messages_rules_1.directKey)(me.id, target.id);
            const find = () => db_1.default.conversation.findUnique({ where: { tenantId_directKey: { tenantId, directKey: key } } });
            let convo = await find();
            if (!convo) {
                try {
                    convo = await db_1.default.conversation.create({
                        data: { tenantId, kind: 'DIRECT', directKey: key, members: { create: [{ userId: me.id }, { userId: target.id }] } },
                    });
                }
                catch (e) {
                    if (e?.code !== 'P2002')
                        throw e;
                    convo = await find(); // both people opened it at the same moment
                }
            }
            return apiResponse_1.default.success(res, { id: convo.id }, 'Conversation ready');
        }
        catch (error) {
            next(error);
        }
    }
    /** A page of messages, oldest first. Pass `before` (a message time) to load older ones. */
    static async history(req, res, next) {
        try {
            if (!needSociety(req, res))
                return;
            const opened = await openConversation(req, req.params.id);
            if (!opened)
                return apiResponse_1.default.error(res, 'Conversation not found.', null, 404);
            const { convo, other } = opened;
            const limit = Math.min(Number(req.query.limit) || 30, 60);
            const before = req.query.before ? new Date(String(req.query.before)) : null;
            if (before && Number.isNaN(+before))
                return apiResponse_1.default.error(res, 'Invalid "before" time.', null, 400);
            const rows = await db_1.default.message.findMany({
                relationLoadStrategy: 'join',
                where: { conversationId: convo.id, ...(before ? { createdAt: { lt: before } } : {}) },
                orderBy: { createdAt: 'desc' },
                take: limit + 1,
                include: { sender: { select: personSelect } },
            });
            const hasMore = rows.length > limit;
            const messages = rows.slice(0, limit).reverse().map(publicMessage);
            // For a one-to-one chat: when did the other person last read it (for the "Seen" tick)
            return apiResponse_1.default.success(res, { messages, hasMore, otherReadAt: other?.lastReadAt ?? null }, 'Messages loaded');
        }
        catch (error) {
            next(error);
        }
    }
    static async send(req, res, next) {
        try {
            if (!needSociety(req, res))
                return;
            const tenantId = req.tenantId;
            const me = req.user;
            const { body } = sendSchema.parse(req.body);
            if (me.messagingDisabled)
                return apiResponse_1.default.error(res, 'Messaging has been turned off for your account by the society office.', null, 403);
            if (!allowedToSend(me.id))
                return apiResponse_1.default.error(res, 'You are sending messages very quickly. Please wait a moment.', null, 429);
            const opened = await openConversation(req, req.params.id);
            if (!opened)
                return apiResponse_1.default.error(res, 'Conversation not found.', null, 404);
            const { convo, other } = opened;
            let otherId = null;
            if (convo.kind === 'DIRECT') {
                if (!other || other.user.deletedAt || !(await (0, messages_rules_1.canMessage)(tenantId, { id: me.id, role: me.role }, { id: other.user.id, role: other.user.role.name }))) {
                    return apiResponse_1.default.error(res, 'You can no longer message this person.', null, 403);
                }
                otherId = other.user.id;
            }
            // The three writes are independent, so they go out together
            const now = new Date();
            const [message] = await Promise.all([
                db_1.default.message.create({
                    data: { tenantId, conversationId: convo.id, senderId: me.id, body },
                    include: { sender: { select: personSelect } },
                }),
                db_1.default.conversation.update({ where: { id: convo.id }, data: { lastMessageAt: now, lastMessagePreview: body.slice(0, 140) } }),
                // Sending counts as having read everything before it
                db_1.default.conversationMember.updateMany({ where: { conversationId: convo.id, userId: me.id }, data: { lastReadAt: now } }),
            ]);
            const payload = { kind: convo.kind, title: convo.title, message: publicMessage(message) };
            if (convo.kind === 'COMMUNITY')
                (0, hub_1.emitToRoles)(tenantId, messages_rules_1.COMMUNITY_ROLES, 'message:new', payload);
            else
                (0, hub_1.emitToUsers)([me.id, otherId], 'message:new', payload);
            // Someone with the app closed gets one bell notification, not one per message
            if (otherId && !(0, hub_1.isOnline)(otherId)) {
                const title = `New message from ${fullName(message.sender)}`;
                const recent = await db_1.default.notification.findFirst({
                    where: { userId: otherId, type: 'MESSAGE', title, isRead: false, createdAt: { gt: new Date(Date.now() - 30 * 60_000) } },
                    select: { id: true },
                });
                if (!recent)
                    await (0, payments_1.notifyUsers)(tenantId, [otherId], title, body.slice(0, 120), 'MESSAGE');
            }
            return apiResponse_1.default.success(res, payload.message, 'Sent', 201);
        }
        catch (error) {
            next(error);
        }
    }
    /** Mark the conversation as read up to now. */
    static async markRead(req, res, next) {
        try {
            if (!needSociety(req, res))
                return;
            const me = req.user;
            const opened = await openConversation(req, req.params.id);
            if (!opened)
                return apiResponse_1.default.error(res, 'Conversation not found.', null, 404);
            const { convo, other } = opened;
            const at = new Date();
            await db_1.default.conversationMember.updateMany({ where: { conversationId: convo.id, userId: me.id }, data: { lastReadAt: at } });
            (0, hub_1.emitToUsers)([me.id], 'message:seen', { conversationId: convo.id }); // clears the badge on my other devices
            if (other)
                (0, hub_1.emitToUsers)([other.user.id], 'message:read', { conversationId: convo.id, at });
            return apiResponse_1.default.success(res, null, 'Marked as read');
        }
        catch (error) {
            next(error);
        }
    }
    /** Delete a message: the sender can delete their own; the office can remove anything in the community channel. */
    static async remove(req, res, next) {
        try {
            if (!needSociety(req, res))
                return;
            const tenantId = req.tenantId;
            const me = req.user;
            const msg = await db_1.default.message.findFirst({ where: { id: req.params.id, tenantId, deletedAt: null }, include: { conversation: true } });
            if (!msg)
                return apiResponse_1.default.error(res, 'Message not found.', null, 404);
            const opened = await openConversation(req, msg.conversationId);
            const convo = opened?.convo;
            const isOffice = messages_rules_1.OFFICE_ROLES.includes(me.role);
            if (!convo || !(msg.senderId === me.id || (isOffice && convo.kind === 'COMMUNITY'))) {
                return apiResponse_1.default.error(res, 'You cannot delete this message.', null, 403);
            }
            await db_1.default.message.update({ where: { id: msg.id }, data: { deletedAt: new Date(), deletedBy: me.id } });
            await broadcast(tenantId, convo, 'message:deleted', { conversationId: convo.id, messageId: msg.id });
            return apiResponse_1.default.success(res, null, 'Message deleted');
        }
        catch (error) {
            next(error);
        }
    }
}
exports.MessagesController = MessagesController;
