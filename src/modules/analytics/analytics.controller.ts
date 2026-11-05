import { Request, Response, NextFunction } from 'express';
import prisma from '../../configs/db';
import ApiResponse from '../../utils/apiResponse';

export class AnalyticsController {
  // Main Dashboard Metrics resolving dynamically based on User Role
  static async getDashboardStats(req: Request, res: Response, next: NextFunction) {
    try {
      const userRole = req.user!.role;
      const tenantId = req.tenantId;

      // 1. Super Admin View (Multi-Tenant SaaS Overview)
      if (userRole === 'Super Admin') {
        const [totalTenants, activeTenants, subscriptions, tenantsDetails] = await Promise.all([
          prisma.tenant.count({ where: { deletedAt: null } }),
          prisma.tenant.count({ where: { isActive: true, deletedAt: null } }),
          prisma.subscription.findMany(),
          prisma.tenant.findMany({
            where: { deletedAt: null },
            select: {
              id: true,
              name: true,
              slug: true,
              themePrimary: true,
              themeSecondary: true,
              isActive: true,
              subscriptionStatus: true,
              createdAt: true,
              subscription: true,
            },
          }),
        ]);

        return ApiResponse.success(res, {
          view: 'SUPER_ADMIN',
          stats: {
            totalTenants,
            activeTenants,
            suspendedTenants: totalTenants - activeTenants,
          },
          subscriptions,
          tenants: tenantsDetails,
        }, 'Super admin analytics loaded');
      }

      // 2. Society Admin / Committee View (Single-Tenant Overview)
      if (userRole === 'Society Admin' || userRole === 'Society Secretary' || userRole === 'Committee Member' || userRole === 'Accountant') {
        const [
          totalResidents,
          totalGuards,
          openComplaints,
          resolvedComplaints,
          visitorsToday,
          aggregateInvoice,
        ] = await Promise.all([
          prisma.resident.count({ where: { tenantId, deletedAt: null } }),
          prisma.staff.count({ where: { tenantId, type: 'Guard', deletedAt: null } }),
          prisma.complaint.count({ where: { tenantId, status: 'OPEN', deletedAt: null } }),
          prisma.complaint.count({ where: { tenantId, status: 'RESOLVED', deletedAt: null } }),
          prisma.visitorLog.count({
            where: { tenantId, checkedInAt: { gte: new Date(new Date().setHours(0, 0, 0, 0)) } },
          }),
          // Financial collection ratios
          prisma.maintenanceInvoice.aggregate({
            where: { tenantId, deletedAt: null },
            _sum: { totalAmount: true, paidAmount: true },
          }),
        ]);

        const totalBilled = Number(aggregateInvoice._sum.totalAmount || 0);
        const totalCollected = Number(aggregateInvoice._sum.paidAmount || 0);

        return ApiResponse.success(res, {
          view: 'SOCIETY_ADMIN',
          stats: {
            residentsCount: totalResidents,
            guardsCount: totalGuards,
            openComplaints,
            resolvedComplaints,
            visitorsTodayCount: visitorsToday,
            financials: {
              totalBilled,
              totalCollected,
              outstanding: totalBilled - totalCollected,
            },
          },
        }, 'Society admin analytics loaded');
      }

      // 3. Supervisor View (Staff coordination dashboard)
      if (userRole === 'Supervisor') {
        const [totalResidents, totalGuards, openComplaints, visitorsToday] = await Promise.all([
          prisma.resident.count({ where: { tenantId, deletedAt: null } }),
          prisma.staff.count({ where: { tenantId, type: 'Guard', deletedAt: null } }),
          prisma.complaint.count({ where: { tenantId, status: 'OPEN', deletedAt: null } }),
          prisma.visitorLog.count({
            where: { tenantId, checkedInAt: { gte: new Date(new Date().setHours(0, 0, 0, 0)) } },
          }),
        ]);

        return ApiResponse.success(res, {
          view: 'SUPERVISOR',
          stats: {
            residentsCount: totalResidents,
            guardsCount: totalGuards,
            openComplaints,
            visitorsTodayCount: visitorsToday,
          },
        }, 'Supervisor dashboard analytics loaded');
      }

      // 4. Guard View (Security details)
      if (userRole === 'Security Guard') {
        const visitorsToday = await prisma.visitorLog.count({
          where: {
            tenantId,
            checkedInAt: {
              gte: new Date(new Date().setHours(0, 0, 0, 0)),
            },
          },
        });

        return ApiResponse.success(res, {
          view: 'GUARD',
          stats: {
            visitorsTodayCount: visitorsToday,
          },
        }, 'Guard dashboard analytics loaded');
      }

      // 5. Staff View (Plumber, Electrician, Cleaner, Maintenance Staff)
      if (
        userRole === 'Plumber' ||
        userRole === 'Electrician' ||
        userRole === 'Cleaner' ||
        userRole === 'Maintenance Staff'
      ) {
        const myOpenComplaints = await prisma.complaint.count({
          where: {
            tenantId,
            assignedTo: req.user!.id,
            status: { in: ['OPEN', 'IN_PROGRESS'] },
            deletedAt: null,
          },
        });

        return ApiResponse.success(res, {
          view: 'STAFF',
          stats: {
            myOpenComplaints,
          },
        }, 'Staff dashboard analytics loaded');
      }

      // 6. Resident View (Personalized flat details)
      const resident = await prisma.resident.findFirst({ relationLoadStrategy: 'join',
        where: { userId: req.user!.id, tenantId, deletedAt: null },
        include: { flat: true },
      });

      if (!resident) {
        return ApiResponse.error(res, 'Resident profile not found', null, 404);
      }

      const [personalComplaints, personalPendingBills, visitorPasses] = await Promise.all([
        prisma.complaint.count({
          where: { raisedBy: req.user!.id, tenantId, deletedAt: null },
        }),
        // A renter never sees the society's bills for the flat
        userRole === 'Tenant' ? Promise.resolve(0) : prisma.maintenanceInvoice.count({
          where: { flatId: resident.flatId || '', tenantId, status: { in: ['UNPAID', 'PARTIALLY_PAID'] }, deletedAt: null },
        }),
        prisma.visitor.count({
          where: { preApprovedBy: resident.id, tenantId },
        }),
      ]);

      return ApiResponse.success(res, {
        view: 'RESIDENT',
        flatDetails: resident.flat,
        stats: {
          myComplaintsCount: personalComplaints,
          myPendingBillsCount: personalPendingBills,
          myVisitorPassesCount: visitorPasses,
        },
      }, 'Resident profile analytics loaded');
    } catch (error) {
      next(error);
    }
  }
}
export default AnalyticsController;
