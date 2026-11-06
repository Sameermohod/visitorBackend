"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.startEscalationScheduler = exports.runEscalations = exports.escalateComplaint = exports.EscalationError = exports.LEVEL_OF = exports.ESCALATION_TARGETS = void 0;
const db_1 = __importDefault(require("../configs/db"));
const logger_1 = __importDefault(require("../configs/logger"));
const emailService_1 = require("../utils/emailService");
const payments_1 = require("./payments");
const responseCache_1 = require("../middleware/responseCache");
exports.ESCALATION_TARGETS = ['Society Secretary', 'Society Admin'];
exports.LEVEL_OF = { 'Society Secretary': 1, 'Society Admin': 2 };
const DAY_MS = 24 * 60 * 60 * 1000;
class EscalationError extends Error {
    status;
    constructor(message, status = 400) {
        super(message);
        this.status = status;
    }
}
exports.EscalationError = EscalationError;
/**
 * Moves a complaint up to the Secretary or the Admin and tells them (and the person who raised it).
 * If the society has no Secretary yet, the Admin is used instead.
 */
const escalateComplaint = async ({ complaintId, tenantId, to, byUserId, note }) => {
    const complaint = await db_1.default.complaint.findFirst({
        where: { id: complaintId, tenantId, deletedAt: null },
        include: {
            resident: { select: { id: true, firstName: true, email: true } },
            staff: { select: { firstName: true, lastName: true } },
        },
    });
    if (!complaint)
        throw new EscalationError('Complaint not found.', 404);
    if (complaint.status === 'RESOLVED' || complaint.status === 'CLOSED') {
        throw new EscalationError('This complaint is already resolved.');
    }
    let target = to;
    let recipients = await db_1.default.user.findMany({
        where: { tenantId, deletedAt: null, role: { name: target } },
        select: { id: true, email: true, firstName: true },
    });
    if (!recipients.length && target === 'Society Secretary') {
        target = 'Society Admin';
        recipients = await db_1.default.user.findMany({
            where: { tenantId, deletedAt: null, role: { name: target } },
            select: { id: true, email: true, firstName: true },
        });
    }
    if (!recipients.length)
        throw new EscalationError('There is nobody to escalate to yet.', 409);
    const level = exports.LEVEL_OF[target];
    if (level <= complaint.escalationLevel) {
        throw new EscalationError(complaint.escalationLevel >= 2
            ? 'This complaint is already escalated to the Society Admin, the highest level.'
            : 'This complaint is already escalated to the Society Secretary. You can escalate it further to the Society Admin.');
    }
    const updated = await db_1.default.complaint.update({
        where: { id: complaint.id },
        data: {
            escalationLevel: level,
            escalatedTo: target,
            escalatedAt: new Date(),
            escalatedBy: byUserId ?? null,
            escalationNote: note || null,
            // Escalated problems jump the line
            priority: complaint.priority === 'LOW' || complaint.priority === 'MEDIUM' ? 'HIGH' : complaint.priority,
        },
    });
    (0, responseCache_1.invalidateTenantCache)(tenantId);
    if (byUserId) {
        await db_1.default.complaintComment.create({
            data: { tenantId, complaintId: complaint.id, userId: byUserId, comment: `Escalated to the ${target}${note ? `: ${note}` : '.'}` },
        });
    }
    const why = byUserId ? (note ? `Reason: ${note}` : 'It was escalated by a colleague.') : 'It passed its deadline without being resolved, so it was escalated automatically.';
    const action = `This complaint needs your attention. ${why}${complaint.staff ? ` Assigned to ${complaint.staff.firstName} ${complaint.staff.lastName}.` : ' Nobody is assigned yet.'}`;
    await (0, payments_1.notifyUsers)(tenantId, recipients.map((r) => r.id), `Escalated: ${complaint.title}`, `${complaint.ticketNumber} · ${why}`, 'COMPLAINT');
    for (const r of recipients) {
        (0, emailService_1.sendEmail)(r.email, `🚨 Escalated complaint: ${complaint.ticketNumber}`, (0, emailService_1.getComplaintUpdateTemplate)(r.firstName, complaint.ticketNumber, complaint.title, complaint.status, complaint.category, action))
            .catch((err) => logger_1.default.error(`SMTP: Failed to send escalation email to ${r.email}:`, err));
    }
    if (complaint.resident.id !== byUserId) {
        await (0, payments_1.notifyUsers)(tenantId, [complaint.resident.id], 'Your complaint was escalated', `${complaint.ticketNumber} has been passed to the ${target} to get it resolved.`, 'COMPLAINT');
    }
    return { complaint: updated, escalatedTo: target };
};
exports.escalateComplaint = escalateComplaint;
/** Hourly: overdue complaints go to the Secretary, and if still open a day later, to the Admin. */
const runEscalations = async (now = new Date()) => {
    const overdue = await db_1.default.complaint.findMany({
        where: {
            deletedAt: null,
            status: { in: ['OPEN', 'IN_PROGRESS'] },
            slaDue: { lt: now },
            OR: [{ escalationLevel: 0 }, { escalationLevel: 1, escalatedAt: { lt: new Date(now.getTime() - DAY_MS) } }],
        },
        select: { id: true, tenantId: true, escalationLevel: true },
        take: 200,
    });
    let escalated = 0;
    for (const c of overdue) {
        try {
            await (0, exports.escalateComplaint)({ complaintId: c.id, tenantId: c.tenantId, to: c.escalationLevel === 0 ? 'Society Secretary' : 'Society Admin' });
            escalated++;
        }
        catch (e) {
            // e.g. nobody to escalate to: try again next hour
            if (!(e instanceof EscalationError))
                logger_1.default.error(`Escalation failed for complaint ${c.id}:`, e);
        }
    }
    if (escalated)
        logger_1.default.info(`Escalations: ${escalated} overdue complaint(s) escalated.`);
    return { escalated };
};
exports.runEscalations = runEscalations;
let timer = null;
const startEscalationScheduler = () => {
    if (process.env.ESCALATION_ENABLED === 'false' || timer)
        return;
    const tick = () => (0, exports.runEscalations)().catch((e) => logger_1.default.error('Escalation run crashed:', e));
    setTimeout(tick, 2 * 60 * 1000).unref();
    timer = setInterval(tick, 60 * 60 * 1000);
    timer.unref();
    logger_1.default.info('Escalation scheduler started (checks every hour).');
};
exports.startEscalationScheduler = startEscalationScheduler;
