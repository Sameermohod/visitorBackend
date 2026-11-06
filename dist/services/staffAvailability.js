"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.promoteQueue = exports.availabilityOne = exports.availabilityFor = exports.isOnLeave = exports.MAX_ACTIVE_JOBS = void 0;
const db_1 = __importDefault(require("../configs/db"));
const payments_1 = require("./payments");
const responseCache_1 = require("../middleware/responseCache");
/** A technician with this many jobs already in progress counts as busy. */
exports.MAX_ACTIVE_JOBS = Number(process.env.STAFF_MAX_ACTIVE_JOBS) || 2;
const today = () => new Date(new Date().toISOString().slice(0, 10));
const isOnLeave = (s, now = today()) => !!s.onLeaveUntil && (!s.onLeaveFrom || s.onLeaveFrom <= now) && s.onLeaveUntil >= now;
exports.isOnLeave = isOnLeave;
/** Status, workload and queue length for a set of staff, using two grouped queries. */
const availabilityFor = async (tenantId, staff) => {
    const ids = staff.map((s) => s.id);
    const [active, queued] = ids.length
        ? await Promise.all([
            db_1.default.complaint.groupBy({
                by: ['assignedTo'],
                where: { tenantId, deletedAt: null, assignedTo: { in: ids }, status: 'IN_PROGRESS' },
                _count: { _all: true },
            }),
            db_1.default.complaint.groupBy({
                by: ['assignedTo'],
                where: { tenantId, deletedAt: null, assignedTo: { in: ids }, status: 'OPEN', queuedAt: { not: null } },
                _count: { _all: true },
            }),
        ])
        : [[], []];
    const result = new Map();
    for (const s of staff) {
        const activeJobs = active.find((a) => a.assignedTo === s.id)?._count._all ?? 0;
        const queuedJobs = queued.find((q) => q.assignedTo === s.id)?._count._all ?? 0;
        const onLeave = (0, exports.isOnLeave)(s);
        result.set(s.id, {
            status: onLeave ? 'ON_LEAVE' : activeJobs >= exports.MAX_ACTIVE_JOBS ? 'BUSY' : 'AVAILABLE',
            activeJobs,
            queued: queuedJobs,
            onLeaveUntil: onLeave ? s.onLeaveUntil : null,
            leaveReason: onLeave ? s.leaveReason : null,
        });
    }
    return result;
};
exports.availabilityFor = availabilityFor;
const availabilityOne = async (tenantId, staff) => (await (0, exports.availabilityFor)(tenantId, [staff])).get(staff.id);
exports.availabilityOne = availabilityOne;
/**
 * A job finished (or the technician was reassigned): start the oldest queued complaints while there is room.
 * Tells the technician and the person who raised each complaint.
 */
const promoteQueue = async (tenantId, staffId) => {
    const staff = await db_1.default.staff.findFirst({
        where: { id: staffId, tenantId, deletedAt: null },
        select: { id: true, userId: true, firstName: true, lastName: true, onLeaveFrom: true, onLeaveUntil: true, leaveReason: true },
    });
    if (!staff || (0, exports.isOnLeave)(staff))
        return [];
    const started = [];
    for (let guard = 0; guard < 10; guard++) {
        const { activeJobs } = await (0, exports.availabilityOne)(tenantId, staff);
        if (activeJobs >= exports.MAX_ACTIVE_JOBS)
            break;
        const next = await db_1.default.complaint.findFirst({
            where: { tenantId, deletedAt: null, assignedTo: staffId, status: 'OPEN', queuedAt: { not: null } },
            orderBy: { queuedAt: 'asc' },
        });
        if (!next)
            break;
        await db_1.default.complaint.update({ where: { id: next.id }, data: { status: 'IN_PROGRESS', queuedAt: null } });
        (0, responseCache_1.invalidateTenantCache)(tenantId);
        started.push({ id: next.id, ticketNumber: next.ticketNumber, title: next.title });
        await (0, payments_1.notifyUsers)(tenantId, [next.raisedBy], 'Your complaint has been started', `${staff.firstName} ${staff.lastName} has started work on “${next.title}” (${next.ticketNumber}).`, 'COMPLAINT');
        if (staff.userId) {
            await (0, payments_1.notifyUsers)(tenantId, [staff.userId], 'Next job from your queue', `“${next.title}” (${next.ticketNumber}) is now in progress.`, 'COMPLAINT');
        }
    }
    return started;
};
exports.promoteQueue = promoteQueue;
