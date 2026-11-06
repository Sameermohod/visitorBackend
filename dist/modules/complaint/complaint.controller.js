"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ComplaintController = void 0;
const zod_1 = require("zod");
const db_1 = __importDefault(require("../../configs/db"));
const apiResponse_1 = __importDefault(require("../../utils/apiResponse"));
const logger_1 = __importDefault(require("../../configs/logger"));
const emailService_1 = require("../../utils/emailService");
const pagination_1 = require("../../utils/pagination");
const payments_1 = require("../../services/payments");
const staffAvailability_1 = require("../../services/staffAvailability");
const escalation_1 = require("../../services/escalation");
const tenancyAccess_1 = require("../../services/tenancyAccess");
const complaintCreateSchema = zod_1.z.object({
    title: zod_1.z.string().min(3),
    description: zod_1.z.string().min(10),
    priority: zod_1.z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']).default('MEDIUM'),
    attachments: zod_1.z.array(zod_1.z.string()).optional().default([]),
    staffId: zod_1.z.string().uuid().optional(),
    // The chosen technician is busy: join their queue instead of being refused
    queue: zod_1.z.boolean().optional(),
});
const assignSchema = zod_1.z.object({ staffId: zod_1.z.string().uuid(), queue: zod_1.z.boolean().optional() });
const commentSchema = zod_1.z.object({ comment: zod_1.z.string().min(1), attachments: zod_1.z.array(zod_1.z.string()).optional().default([]) });
const escalateSchema = zod_1.z.object({ to: zod_1.z.enum(escalation_1.ESCALATION_TARGETS), note: zod_1.z.string().max(500).optional() });
// Roles that run complaints: they see every complaint and can assign, change status and escalate at any time
const MANAGERS = ['Society Admin', 'Society Secretary', 'Committee Member'];
const isManager = (role) => role === 'Super Admin' || MANAGERS.includes(role);
// A technician's own staff record (links the login to the complaints assigned to them)
const staffOfUser = (tenantId, userId) => db_1.default.staff.findFirst({ where: { tenantId, userId, deletedAt: null }, select: { id: true } });
// Who may see which complaints: managers all; technicians their own + assigned to them; everyone else only their own
const visibleTo = async (req) => {
    const { role, id } = req.user;
    if (isManager(role))
        return {};
    const mine = { raisedBy: id };
    if (role === 'Maintenance Staff') {
        const staff = await staffOfUser(req.tenantId, id);
        return staff ? { OR: [mine, { assignedTo: staff.id }] } : mine;
    }
    return mine;
};
const loadVisible = async (req, complaintId) => db_1.default.complaint.findFirst({ relationLoadStrategy: 'join',
    where: { id: complaintId, tenantId: req.tenantId, deletedAt: null, ...(await visibleTo(req)) },
    include: { staff: { select: { id: true, userId: true, firstName: true, lastName: true, type: true, phoneNumber: true } } }, });
const staffLine = (s) => `${s.firstName} ${s.lastName}${s.type ? ` (${s.type})` : ''}`;
const mail = (to, subject, name, c, status, action) => {
    if (!to)
        return;
    (0, emailService_1.sendEmail)(to, subject, (0, emailService_1.getComplaintUpdateTemplate)(name, c.ticketNumber, c.title, status, c.category, action)).catch((err) => logger_1.default.error(`SMTP: Failed to send complaint email to ${to}:`, err));
};
/** Tell the raiser and the technician what happened (in-app + email). `skipUserId` is the person who did it. */
const tellParties = async (tenantId, c, staffUserId, skipUserId, headline, forRaiser, forStaff) => {
    const ids = [c.raisedBy, staffUserId].filter((x) => !!x);
    const users = await db_1.default.user.findMany({ where: { id: { in: ids } }, select: { id: true, email: true, firstName: true } });
    for (const u of users) {
        if (u.id === skipUserId)
            continue;
        const text = u.id === c.raisedBy ? forRaiser : forStaff;
        await (0, payments_1.notifyUsers)(tenantId, [u.id], headline, `${c.ticketNumber} · ${text}`, 'COMPLAINT');
        mail(u.email, `${headline}: ${c.ticketNumber}`, u.firstName, c, c.status, text);
    }
};
/** Decides how a complaint goes to a technician: straight away, into their queue, or not at all. */
const placeWithStaff = async (tenantId, staffId, queue) => {
    const staff = await db_1.default.staff.findFirst({
        where: { id: staffId, tenantId, deletedAt: null },
        select: { id: true, userId: true, firstName: true, lastName: true, type: true, phoneNumber: true, isActive: true, onLeaveFrom: true, onLeaveUntil: true, leaveReason: true },
    });
    if (!staff || !staff.isActive)
        return { ok: false, status: 404, message: 'That staff member was not found.' };
    const a = await (0, staffAvailability_1.availabilityOne)(tenantId, staff);
    const contact = { staffId: staff.id, name: staffLine(staff), phoneNumber: staff.phoneNumber };
    if (a.status === 'ON_LEAVE') {
        const until = a.onLeaveUntil ? a.onLeaveUntil.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : 'further notice';
        return {
            ok: false, status: 409,
            message: `${staff.firstName} is on leave until ${until}. Choose someone else or call them.`,
            errors: { code: 'STAFF_ON_LEAVE', ...contact, onLeaveUntil: a.onLeaveUntil },
        };
    }
    if (a.status === 'BUSY' && !queue) {
        return {
            ok: false, status: 409,
            message: `${staff.firstName} is busy with ${a.activeJobs} job(s) right now (${a.queued} waiting). Add the complaint to their queue, or call them.`,
            errors: { code: 'STAFF_BUSY', ...contact, activeJobs: a.activeJobs, queued: a.queued },
        };
    }
    return { ok: true, staff, queued: a.status === 'BUSY', position: a.queued + 1 };
};
class ComplaintController {
    // Anyone can raise a complaint. Optionally hand it straight to a technician (or join their queue if they are busy).
    static async raiseComplaint(req, res, next) {
        try {
            if (!(await (0, tenancyAccess_1.allowTenantFeature)(req, res, 'complaints')))
                return; // the owner can switch a renter's complaints off
            const tenantId = req.tenantId;
            const data = complaintCreateSchema.parse(req.body);
            const raiser = req.user;
            // 1. Heuristic categorisation
            let category = 'GENERAL';
            const text = `${data.title} ${data.description}`.toLowerCase();
            if (/\b(leak|water|pipe|clog|tap|plumb|flush)\b/.test(text))
                category = 'PLUMBING';
            else if (/\b(wire|light|power|electric|spark|fuse|mcb|switch|bulb)\b/.test(text))
                category = 'ELECTRICAL';
            else if (/\b(lift|elevator|escalator|lobby|gate|door|gym)\b/.test(text))
                category = 'INFRASTRUCTURE';
            else if (/\b(guard|thief|intruder|camera|cctv|lock|security|theft)\b/.test(text))
                category = 'SAFETY';
            // 2. SLA deadline from priority: this is what "not resolved on time" is measured against
            const slaDue = new Date();
            if (data.priority === 'URGENT')
                slaDue.setHours(slaDue.getHours() + 4);
            else if (data.priority === 'HIGH')
                slaDue.setDate(slaDue.getDate() + 1);
            else if (data.priority === 'MEDIUM')
                slaDue.setDate(slaDue.getDate() + 3);
            else
                slaDue.setDate(slaDue.getDate() + 5);
            // 3. Optional technician
            let placement = null;
            if (data.staffId) {
                placement = await placeWithStaff(tenantId, data.staffId, data.queue);
                if (!placement.ok)
                    return apiResponse_1.default.error(res, placement.message, placement.errors ?? null, placement.status);
            }
            const staff = placement?.ok ? placement.staff : null;
            const queued = !!(placement?.ok && placement.queued);
            const position = placement?.ok ? placement.position : null;
            const complaint = await db_1.default.complaint.create({
                data: {
                    tenantId,
                    ticketNumber: `TIC-${tenantId.slice(0, 4)}-${Math.floor(100000 + Math.random() * 900000)}`,
                    raisedBy: raiser.id,
                    title: data.title,
                    description: data.description,
                    category,
                    priority: data.priority,
                    slaDue,
                    attachments: data.attachments,
                    status: staff && !queued ? 'IN_PROGRESS' : 'OPEN',
                    assignedTo: staff?.id ?? null,
                    queuedAt: queued ? new Date() : null,
                },
            });
            // Confirmation to the raiser, and a heads-up to the technician
            const me = await db_1.default.user.findUnique({ where: { id: raiser.id }, select: { email: true, firstName: true } });
            mail(me?.email, `📝 Complaint filed: ${complaint.ticketNumber}`, me?.firstName ?? 'there', complaint, complaint.status, staff ? (queued ? `Filed and added to ${staffLine(staff)}'s queue (${position ?? 1} in line). You can call them from the app.` : `Filed and assigned to ${staffLine(staff)}. Work is in progress.`)
                : `Filed. We will assign it soon. Target: ${data.priority} priority.`);
            if (staff?.userId) {
                await (0, payments_1.notifyUsers)(tenantId, [staff.userId], queued ? 'New complaint in your queue' : 'New complaint assigned to you', `${complaint.ticketNumber} · ${complaint.title}`, 'COMPLAINT');
                const su = await db_1.default.user.findUnique({ where: { id: staff.userId }, select: { email: true, firstName: true } });
                mail(su?.email, `🛠️ ${queued ? 'Queued' : 'New task'}: ${complaint.ticketNumber}`, su?.firstName ?? 'there', complaint, complaint.status, `${data.title}. ${data.description}`);
            }
            return apiResponse_1.default.success(res, { ...complaint, queued, queuePosition: queued ? position : null }, staff
                ? queued ? `Complaint raised and added to ${staff.firstName}'s queue.` : `Complaint raised and assigned to ${staff.firstName}.`
                : `Complaint raised. Category: ${category}.`, 201);
        }
        catch (error) {
            next(error);
        }
    }
    // The complaints the signed-in person is allowed to see
    static async getComplaints(req, res, next) {
        try {
            const tenantId = req.tenantId;
            const status = req.query.status;
            const manager = isManager(req.user.role);
            const complaints = await db_1.default.complaint.findMany({ relationLoadStrategy: 'join',
                where: { tenantId, deletedAt: null, ...(await visibleTo(req)), ...(status ? { status: status } : {}) },
                include: {
                    resident: { select: { firstName: true, lastName: true, phoneNumber: true, ...(manager ? { email: true } : {}) } },
                    // Never the whole staff row: it carries salary and login details
                    staff: { select: { id: true, userId: true, firstName: true, lastName: true, type: true, phoneNumber: true } },
                    comments: {
                        include: { user: { select: { firstName: true, lastName: true } } },
                        orderBy: { createdAt: 'asc' },
                    },
                },
                orderBy: { createdAt: 'desc' },
                ...(0, pagination_1.getPagination)(req), });
            // Place in the technician's queue, and whether the deadline has passed
            const now = Date.now();
            const queuedByStaff = new Map();
            for (const c of [...complaints].filter((x) => x.queuedAt && x.assignedTo).sort((a, b) => +a.queuedAt - +b.queuedAt)) {
                queuedByStaff.set(c.assignedTo, [...(queuedByStaff.get(c.assignedTo) ?? []), c.id]);
            }
            const data = complaints.map((c) => ({
                ...c,
                queuePosition: c.queuedAt && c.assignedTo ? (queuedByStaff.get(c.assignedTo)?.indexOf(c.id) ?? 0) + 1 : null,
                overdue: !!c.slaDue && c.slaDue.getTime() < now && c.status !== 'RESOLVED' && c.status !== 'CLOSED',
            }));
            return apiResponse_1.default.success(res, data, 'Complaints loaded successfully');
        }
        catch (error) {
            next(error);
        }
    }
    // Managers assign (or reassign) a complaint to a technician. Busy -> queue; on leave -> refused.
    static async assignStaff(req, res, next) {
        try {
            const tenantId = req.tenantId;
            if (!isManager(req.user.role)) {
                return apiResponse_1.default.error(res, 'Only the Admin, Secretary or Committee can assign complaints.', null, 403);
            }
            const { staffId, queue } = assignSchema.parse(req.body);
            const existing = await loadVisible(req, req.params.complaintId);
            if (!existing)
                return apiResponse_1.default.error(res, 'Complaint not found.', null, 404);
            if (existing.status === 'RESOLVED' || existing.status === 'CLOSED') {
                return apiResponse_1.default.error(res, 'This complaint is already resolved.', null, 400);
            }
            // Re-assigning to the same person who already has it is a no-op
            if (existing.assignedTo === staffId)
                return apiResponse_1.default.success(res, existing, 'Already assigned to this person.');
            const placement = await placeWithStaff(tenantId, staffId, queue);
            if (!placement.ok)
                return apiResponse_1.default.error(res, placement.message, placement.errors ?? null, placement.status);
            const { staff, queued, position } = placement;
            const complaint = await db_1.default.complaint.update({
                where: { id: existing.id },
                data: { assignedTo: staff.id, status: queued ? 'OPEN' : 'IN_PROGRESS', queuedAt: queued ? new Date() : null },
            });
            // The previous technician has room again
            if (existing.assignedTo)
                await (0, staffAvailability_1.promoteQueue)(tenantId, existing.assignedTo);
            await tellParties(tenantId, complaint, staff.userId, req.user.id, queued ? 'Complaint queued' : 'Technician assigned', queued ? `${staffLine(staff)} is busy, so your complaint is ${position} in their queue. You can call them from the app.` : `${staffLine(staff)} has been assigned and work is in progress.`, queued ? `A complaint was added to your queue (${position} in line): ${complaint.title}.` : `You have been assigned: ${complaint.title}. Priority ${complaint.priority}.`);
            return apiResponse_1.default.success(res, { ...complaint, queued, queuePosition: queued ? position : null }, queued ? `${staff.firstName} is busy. The complaint is in their queue (${position} in line).` : `Assigned to ${staff.firstName}.`);
        }
        catch (error) {
            next(error);
        }
    }
    // Managers (any complaint) and the assigned technician (their own) change the status
    static async updateStatus(req, res, next) {
        try {
            const tenantId = req.tenantId;
            const status = req.body.status;
            if (!['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'].includes(status)) {
                return apiResponse_1.default.error(res, 'Invalid status update command.', null, 400);
            }
            const existing = await loadVisible(req, req.params.complaintId);
            if (!existing)
                return apiResponse_1.default.error(res, 'Complaint not found.', null, 404);
            const isAssignedTech = !!existing.staff?.userId && existing.staff.userId === req.user.id;
            if (!isManager(req.user.role) && !isAssignedTech) {
                return apiResponse_1.default.error(res, 'Only the assigned technician or the society office can update this complaint.', null, 403);
            }
            const done = status === 'RESOLVED' || status === 'CLOSED';
            const complaint = await db_1.default.complaint.update({
                where: { id: existing.id },
                // Starting work or finishing takes it out of the queue
                data: { status, ...(status !== 'OPEN' ? { queuedAt: null } : {}) },
            });
            if (done && existing.assignedTo)
                await (0, staffAvailability_1.promoteQueue)(tenantId, existing.assignedTo);
            await tellParties(tenantId, complaint, existing.staff?.userId, req.user.id, `Complaint ${status.replace('_', ' ').toLowerCase()}`, `Status changed to ${status.replace('_', ' ')}.`, `Status changed to ${status.replace('_', ' ')}.`);
            return apiResponse_1.default.success(res, complaint, `Complaint status updated to ${status}`);
        }
        catch (error) {
            next(error);
        }
    }
    // Raise it to the Secretary or the Admin
    static async escalate(req, res, next) {
        try {
            const tenantId = req.tenantId;
            const { to, note } = escalateSchema.parse(req.body);
            const complaint = await loadVisible(req, req.params.complaintId);
            if (!complaint)
                return apiResponse_1.default.error(res, 'Complaint not found.', null, 404);
            const isRaiser = complaint.raisedBy === req.user.id;
            const isAssignedTech = !!complaint.staff?.userId && complaint.staff.userId === req.user.id;
            const overdue = !!complaint.slaDue && complaint.slaDue.getTime() < Date.now();
            // The person who raised it may escalate once the deadline has passed; the technician and the office any time
            if (!isManager(req.user.role) && !isAssignedTech && !(isRaiser && overdue)) {
                return apiResponse_1.default.error(res, isRaiser ? 'You can escalate once the complaint has passed its deadline.' : 'You cannot escalate this complaint.', { code: 'NOT_OVERDUE', slaDue: complaint.slaDue }, 403);
            }
            const result = await (0, escalation_1.escalateComplaint)({ complaintId: complaint.id, tenantId, to, byUserId: req.user.id, note });
            return apiResponse_1.default.success(res, result.complaint, `Escalated to the ${result.escalatedTo}.`);
        }
        catch (error) {
            if (error instanceof escalation_1.EscalationError)
                return apiResponse_1.default.error(res, error.message, null, error.status);
            next(error);
        }
    }
    // Add an update to a complaint the person is allowed to see
    static async addComment(req, res, next) {
        try {
            const tenantId = req.tenantId;
            const data = commentSchema.parse(req.body);
            const userId = req.user.id;
            const complaint = await loadVisible(req, req.params.complaintId);
            if (!complaint)
                return apiResponse_1.default.error(res, 'Complaint not found.', null, 404);
            const comment = await db_1.default.complaintComment.create({
                data: { tenantId, complaintId: complaint.id, userId, comment: data.comment, attachments: data.attachments },
                include: { user: { select: { firstName: true, lastName: true } } },
            });
            // Tell the other side
            const authorName = comment.user?.firstName || 'Someone';
            const text = `${authorName}: “${data.comment}”`;
            const others = [complaint.raisedBy, complaint.staff?.userId].filter((x) => !!x && x !== userId);
            if (others.length) {
                await (0, payments_1.notifyUsers)(tenantId, others, `New update on ${complaint.ticketNumber}`, text, 'COMPLAINT');
                const users = await db_1.default.user.findMany({ where: { id: { in: others } }, select: { email: true, firstName: true } });
                for (const u of users)
                    mail(u.email, `💬 New comment on ticket ${complaint.ticketNumber}`, u.firstName, complaint, complaint.status, text);
            }
            return apiResponse_1.default.success(res, comment, 'Comment added successfully', 201);
        }
        catch (error) {
            next(error);
        }
    }
}
exports.ComplaintController = ComplaintController;
exports.default = ComplaintController;
