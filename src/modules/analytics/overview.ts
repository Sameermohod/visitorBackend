import { Request, Response, NextFunction } from 'express';
import prisma from '../../configs/db';
import ApiResponse from '../../utils/apiResponse';

const OFFICE = ['Society Admin', 'Society Secretary', 'Committee Member', 'Supervisor', 'Accountant'];
const MONEY = ['Society Admin', 'Society Secretary', 'Accountant'];
const TECH = ['Plumber', 'Electrician', 'Cleaner', 'Maintenance Staff'];

const startOfDay = (d = new Date()) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
const dayKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Visitors per day for the last `days` days (today last), zero-filled. */
const perDay = (dates: Date[], days: number) => {
  const today = startOfDay();
  const buckets = new Map<string, number>();
  const out: { date: string; count: number }[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today); d.setDate(d.getDate() - i);
    buckets.set(dayKey(d), 0);
    out.push({ date: dayKey(d), count: 0 });
  }
  for (const d of dates) { const k = dayKey(d); if (buckets.has(k)) buckets.set(k, buckets.get(k)! + 1); }
  return out.map((o) => ({ ...o, count: buckets.get(o.date) ?? 0 }));
};

const recentNotices = (tenantId: string) => prisma.notice.findMany({
  where: { tenantId, deletedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
  orderBy: { createdAt: 'desc' }, take: 3,
  select: { id: true, title: true, category: true, createdAt: true },
});

/**
 * Extra, role-aware material for the dashboards (charts, "needs attention", recent activity).
 * The headline numbers stay in /analytics/dashboard; this adds what makes the page worth opening.
 */
export class OverviewController {
  static async get(req: Request, res: Response, next: NextFunction) {
    try {
      const role = req.user!.role;
      const tenantId = req.tenantId;
      if (!tenantId || role === 'Super Admin') return ApiResponse.success(res, { view: 'NONE' }, 'Nothing to show');
      const userId = req.user!.id;
      const now = new Date();
      const weekAgo = startOfDay(new Date(Date.now() - 6 * 86400000));

      // ---- Society office, committee, supervisor, accountant ----
      if (OFFICE.includes(role)) {
        const [logs, insideNow, byStatus, overdue, recent, notices, dues] = await Promise.all([
          prisma.visitorLog.findMany({ where: { tenantId, checkedInAt: { gte: weekAgo } }, select: { checkedInAt: true } }),
          prisma.visitorLog.count({ where: { tenantId, checkedOutAt: null, checkedInAt: { gte: startOfDay(new Date(Date.now() - 86400000)) } } }),
          prisma.complaint.groupBy({ by: ['status'], where: { tenantId, deletedAt: null }, _count: { _all: true } }),
          prisma.complaint.count({ where: { tenantId, deletedAt: null, status: { in: ['OPEN', 'IN_PROGRESS'] }, slaDue: { lt: now } } }),
          prisma.complaint.findMany({
            where: { tenantId, deletedAt: null, status: { in: ['OPEN', 'IN_PROGRESS'] } },
            orderBy: [{ createdAt: 'desc' }], take: 5,
            select: { id: true, ticketNumber: true, title: true, status: true, priority: true, slaDue: true, escalationLevel: true, createdAt: true },
          }),
          recentNotices(tenantId),
          MONEY.includes(role)
            ? prisma.maintenanceInvoice.findMany({
              where: { tenantId, deletedAt: null, status: { in: ['UNPAID', 'PARTIALLY_PAID', 'OVERDUE'] } },
              orderBy: { dueDate: 'asc' }, take: 5,
              select: { id: true, title: true, totalAmount: true, paidAmount: true, dueDate: true, flat: { select: { number: true } } },
            })
            : Promise.resolve([]),
        ]);
        const status: Record<string, number> = { OPEN: 0, IN_PROGRESS: 0, RESOLVED: 0, CLOSED: 0 };
        for (const g of byStatus) status[g.status] = g._count._all;
        return ApiResponse.success(res, {
          view: 'OFFICE',
          visitorsWeek: perDay(logs.map((l) => l.checkedInAt), 7),
          insideNow,
          complaintsByStatus: status,
          overdueComplaints: overdue,
          attention: recent.map((c) => ({ ...c, overdue: !!c.slaDue && c.slaDue < now })),
          notices,
          dues: dues.map((d) => ({ id: d.id, title: d.title, flat: d.flat?.number, due: Number(d.totalAmount) - Number(d.paidAmount), dueDate: d.dueDate })),
        }, 'Overview loaded');
      }

      // ---- Security guard ----
      if (role === 'Security Guard') {
        const [logs, insideNow, recent] = await Promise.all([
          prisma.visitorLog.findMany({ where: { tenantId, checkedInAt: { gte: weekAgo } }, select: { checkedInAt: true } }),
          prisma.visitorLog.count({ where: { tenantId, checkedOutAt: null, checkedInAt: { gte: startOfDay(new Date(Date.now() - 86400000)) } } }),
          prisma.visitorLog.findMany({
            where: { tenantId }, orderBy: { checkedInAt: 'desc' }, take: 5,
            select: { id: true, checkedInAt: true, checkedOutAt: true, visitor: { select: { name: true, visitorType: true } }, flat: { select: { number: true } } },
          }),
        ]);
        return ApiResponse.success(res, {
          view: 'GUARD',
          visitorsWeek: perDay(logs.map((l) => l.checkedInAt), 7),
          insideNow,
          recent: recent.map((r) => ({ id: r.id, name: r.visitor?.name, type: r.visitor?.visitorType, flat: r.flat?.number, checkedInAt: r.checkedInAt, checkedOutAt: r.checkedOutAt })),
        }, 'Overview loaded');
      }

      // ---- Technicians ----
      if (TECH.includes(role)) {
        const jobs = await prisma.complaint.findMany({
          where: { tenantId, deletedAt: null, staff: { userId }, status: { in: ['OPEN', 'IN_PROGRESS'] } },
          orderBy: { createdAt: 'asc' }, take: 6,
          select: { id: true, ticketNumber: true, title: true, status: true, priority: true, slaDue: true, createdAt: true },
        });
        const notices = await recentNotices(tenantId);
        return ApiResponse.success(res, { view: 'STAFF', jobs: jobs.map((j) => ({ ...j, overdue: !!j.slaDue && j.slaDue < now })), notices }, 'Overview loaded');
      }

      // ---- Resident / Tenant ----
      const resident = await prisma.resident.findFirst({ where: { userId, tenantId, deletedAt: null }, select: { id: true, flatId: true } });
      const [bills, passes, mine, notices] = await Promise.all([
        role === 'Tenant' || !resident?.flatId ? Promise.resolve([]) : prisma.maintenanceInvoice.findMany({
          where: { tenantId, flatId: resident.flatId, deletedAt: null, status: { in: ['UNPAID', 'PARTIALLY_PAID', 'OVERDUE'] } },
          orderBy: { dueDate: 'asc' }, take: 3,
          select: { id: true, title: true, totalAmount: true, paidAmount: true, dueDate: true },
        }),
        resident ? prisma.visitor.findMany({
          where: { tenantId, preApprovedBy: resident.id, status: { in: ['PRE_APPROVED', 'APPROVED', 'IN_SOCIETY'] }, OR: [{ validUntil: null }, { validUntil: { gt: now } }] },
          orderBy: { createdAt: 'desc' }, take: 3,
          select: { id: true, name: true, status: true, validFrom: true, validUntil: true },
        }) : Promise.resolve([]),
        prisma.complaint.findMany({
          where: { tenantId, raisedBy: userId, deletedAt: null },
          orderBy: { createdAt: 'desc' }, take: 3,
          select: { id: true, ticketNumber: true, title: true, status: true, priority: true, createdAt: true },
        }),
        recentNotices(tenantId),
      ]);
      return ApiResponse.success(res, {
        view: 'RESIDENT',
        bills: bills.map((b) => ({ id: b.id, title: b.title, due: Number(b.totalAmount) - Number(b.paidAmount), dueDate: b.dueDate })),
        passes, complaints: mine, notices,
      }, 'Overview loaded');
    } catch (error) {
      next(error);
    }
  }
}
