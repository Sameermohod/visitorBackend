import prisma from '../configs/db';
import logger from '../configs/logger';
import { sendEmail, getComplaintUpdateTemplate } from '../utils/emailService';
import { notifyUsers } from './payments';
import { invalidateTenantCache } from '../middleware/responseCache';

export const ESCALATION_TARGETS = ['Society Secretary', 'Society Admin'] as const;
export type EscalationTarget = (typeof ESCALATION_TARGETS)[number];
export const LEVEL_OF: Record<EscalationTarget, number> = { 'Society Secretary': 1, 'Society Admin': 2 };

const DAY_MS = 24 * 60 * 60 * 1000;

export class EscalationError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

interface EscalateInput {
  complaintId: string;
  tenantId: string;
  to: EscalationTarget;
  /** undefined for automatic escalations */
  byUserId?: string;
  note?: string;
}

/**
 * Moves a complaint up to the Secretary or the Admin and tells them (and the person who raised it).
 * If the society has no Secretary yet, the Admin is used instead.
 */
export const escalateComplaint = async ({ complaintId, tenantId, to, byUserId, note }: EscalateInput) => {
  const complaint = await prisma.complaint.findFirst({
    where: { id: complaintId, tenantId, deletedAt: null },
    include: {
      resident: { select: { id: true, firstName: true, email: true } },
      staff: { select: { firstName: true, lastName: true } },
    },
  });
  if (!complaint) throw new EscalationError('Complaint not found.', 404);
  if (complaint.status === 'RESOLVED' || complaint.status === 'CLOSED') {
    throw new EscalationError('This complaint is already resolved.');
  }

  let target: EscalationTarget = to;
  let recipients = await prisma.user.findMany({
    where: { tenantId, deletedAt: null, role: { name: target } },
    select: { id: true, email: true, firstName: true },
  });
  if (!recipients.length && target === 'Society Secretary') {
    target = 'Society Admin';
    recipients = await prisma.user.findMany({
      where: { tenantId, deletedAt: null, role: { name: target } },
      select: { id: true, email: true, firstName: true },
    });
  }
  if (!recipients.length) throw new EscalationError('There is nobody to escalate to yet.', 409);

  const level = LEVEL_OF[target];
  if (level <= complaint.escalationLevel) {
    throw new EscalationError(
      complaint.escalationLevel >= 2
        ? 'This complaint is already escalated to the Society Admin, the highest level.'
        : 'This complaint is already escalated to the Society Secretary. You can escalate it further to the Society Admin.'
    );
  }

  const updated = await prisma.complaint.update({
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

  invalidateTenantCache(tenantId);

  if (byUserId) {
    await prisma.complaintComment.create({
      data: { tenantId, complaintId: complaint.id, userId: byUserId, comment: `Escalated to the ${target}${note ? `: ${note}` : '.'}` },
    });
  }

  const why = byUserId ? (note ? `Reason: ${note}` : 'It was escalated by a colleague.') : 'It passed its deadline without being resolved, so it was escalated automatically.';
  const action = `This complaint needs your attention. ${why}${complaint.staff ? ` Assigned to ${complaint.staff.firstName} ${complaint.staff.lastName}.` : ' Nobody is assigned yet.'}`;

  await notifyUsers(tenantId, recipients.map((r) => r.id), `Escalated: ${complaint.title}`, `${complaint.ticketNumber} · ${why}`, 'COMPLAINT');
  for (const r of recipients) {
    sendEmail(r.email, `🚨 Escalated complaint: ${complaint.ticketNumber}`, getComplaintUpdateTemplate(r.firstName, complaint.ticketNumber, complaint.title, complaint.status, complaint.category, action))
      .catch((err) => logger.error(`SMTP: Failed to send escalation email to ${r.email}:`, err));
  }
  if (complaint.resident.id !== byUserId) {
    await notifyUsers(tenantId, [complaint.resident.id], 'Your complaint was escalated', `${complaint.ticketNumber} has been passed to the ${target} to get it resolved.`, 'COMPLAINT');
  }

  return { complaint: updated, escalatedTo: target };
};

/** Hourly: overdue complaints go to the Secretary, and if still open a day later, to the Admin. */
export const runEscalations = async (now = new Date()) => {
  const overdue = await prisma.complaint.findMany({
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
      await escalateComplaint({ complaintId: c.id, tenantId: c.tenantId, to: c.escalationLevel === 0 ? 'Society Secretary' : 'Society Admin' });
      escalated++;
    } catch (e: any) {
      // e.g. nobody to escalate to: try again next hour
      if (!(e instanceof EscalationError)) logger.error(`Escalation failed for complaint ${c.id}:`, e);
    }
  }
  if (escalated) logger.info(`Escalations: ${escalated} overdue complaint(s) escalated.`);
  return { escalated };
};

let timer: NodeJS.Timeout | null = null;

export const startEscalationScheduler = () => {
  if (process.env.ESCALATION_ENABLED === 'false' || timer) return;
  const tick = () => runEscalations().catch((e) => logger.error('Escalation run crashed:', e));
  setTimeout(tick, 2 * 60 * 1000).unref();
  timer = setInterval(tick, 60 * 60 * 1000);
  timer.unref();
  logger.info('Escalation scheduler started (checks every hour).');
};
