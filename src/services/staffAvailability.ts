import prisma from '../configs/db';
import { notifyUsers } from './payments';
import { invalidateTenantCache } from '../middleware/responseCache';

/** A technician with this many jobs already in progress counts as busy. */
export const MAX_ACTIVE_JOBS = Number(process.env.STAFF_MAX_ACTIVE_JOBS) || 2;

export type StaffStatus = 'AVAILABLE' | 'BUSY' | 'ON_LEAVE';

export interface Availability {
  status: StaffStatus;
  activeJobs: number;
  queued: number;
  onLeaveUntil: Date | null;
  leaveReason: string | null;
}

interface LeaveFields {
  onLeaveFrom: Date | null;
  onLeaveUntil: Date | null;
  leaveReason: string | null;
}

const today = () => new Date(new Date().toISOString().slice(0, 10));

export const isOnLeave = (s: Pick<LeaveFields, 'onLeaveFrom' | 'onLeaveUntil'>, now = today()) =>
  !!s.onLeaveUntil && (!s.onLeaveFrom || s.onLeaveFrom <= now) && s.onLeaveUntil >= now;

/** Status, workload and queue length for a set of staff, using two grouped queries. */
export const availabilityFor = async (
  tenantId: string,
  staff: ({ id: string } & LeaveFields)[]
): Promise<Map<string, Availability>> => {
  const ids = staff.map((s) => s.id);
  const [active, queued] = ids.length
    ? await Promise.all([
        prisma.complaint.groupBy({
          by: ['assignedTo'],
          where: { tenantId, deletedAt: null, assignedTo: { in: ids }, status: 'IN_PROGRESS' },
          _count: { _all: true },
        }),
        prisma.complaint.groupBy({
          by: ['assignedTo'],
          where: { tenantId, deletedAt: null, assignedTo: { in: ids }, status: 'OPEN', queuedAt: { not: null } },
          _count: { _all: true },
        }),
      ])
    : [[], []];

  const result = new Map<string, Availability>();
  for (const s of staff) {
    const activeJobs = active.find((a) => a.assignedTo === s.id)?._count._all ?? 0;
    const queuedJobs = queued.find((q) => q.assignedTo === s.id)?._count._all ?? 0;
    const onLeave = isOnLeave(s);
    result.set(s.id, {
      status: onLeave ? 'ON_LEAVE' : activeJobs >= MAX_ACTIVE_JOBS ? 'BUSY' : 'AVAILABLE',
      activeJobs,
      queued: queuedJobs,
      onLeaveUntil: onLeave ? s.onLeaveUntil : null,
      leaveReason: onLeave ? s.leaveReason : null,
    });
  }
  return result;
};

export const availabilityOne = async (tenantId: string, staff: { id: string } & LeaveFields) =>
  (await availabilityFor(tenantId, [staff])).get(staff.id)!;

/**
 * A job finished (or the technician was reassigned): start the oldest queued complaints while there is room.
 * Tells the technician and the person who raised each complaint.
 */
export const promoteQueue = async (tenantId: string, staffId: string) => {
  const staff = await prisma.staff.findFirst({
    where: { id: staffId, tenantId, deletedAt: null },
    select: { id: true, userId: true, firstName: true, lastName: true, onLeaveFrom: true, onLeaveUntil: true, leaveReason: true },
  });
  if (!staff || isOnLeave(staff)) return [];

  const started: { id: string; ticketNumber: string; title: string }[] = [];
  for (let guard = 0; guard < 10; guard++) {
    const { activeJobs } = await availabilityOne(tenantId, staff);
    if (activeJobs >= MAX_ACTIVE_JOBS) break;

    const next = await prisma.complaint.findFirst({
      where: { tenantId, deletedAt: null, assignedTo: staffId, status: 'OPEN', queuedAt: { not: null } },
      orderBy: { queuedAt: 'asc' },
    });
    if (!next) break;

    await prisma.complaint.update({ where: { id: next.id }, data: { status: 'IN_PROGRESS', queuedAt: null } });
    invalidateTenantCache(tenantId);
    started.push({ id: next.id, ticketNumber: next.ticketNumber, title: next.title });

    await notifyUsers(tenantId, [next.raisedBy], 'Your complaint has been started', `${staff.firstName} ${staff.lastName} has started work on “${next.title}” (${next.ticketNumber}).`, 'COMPLAINT');
    if (staff.userId) {
      await notifyUsers(tenantId, [staff.userId], 'Next job from your queue', `“${next.title}” (${next.ticketNumber}) is now in progress.`, 'COMPLAINT');
    }
  }
  return started;
};
