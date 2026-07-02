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
        const totalTenants = await prisma.tenant.count({ where: { deletedAt: null } });
        const activeTenants = await prisma.tenant.count({ where: { isActive: true, deletedAt: null } });
        const subscriptions = await prisma.subscription.findMany();
        
        const tenantsDetails = await prisma.tenant.findMany({
          where: { deletedAt: null },
          include: {
            subscription: true,
          },
        });

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
      if (userRole === 'Society Admin' || userRole === 'Committee Member' || userRole === 'Accountant') {
        const totalResidents = await prisma.resident.count({ where: { tenantId, deletedAt: null } });
        const totalGuards = await prisma.staff.count({ where: { tenantId, type: 'Guard', deletedAt: null } });
        
        const openComplaints = await prisma.complaint.count({ where: { tenantId, status: 'OPEN', deletedAt: null } });
        const resolvedComplaints = await prisma.complaint.count({ where: { tenantId, status: 'RESOLVED', deletedAt: null } });

        const visitorsToday = await prisma.visitorLog.count({
          where: {
            tenantId,
            checkedInAt: {
              gte: new Date(new Date().setHours(0, 0, 0, 0)),
            },
          },
        });

        // Financial collection ratios
        const aggregateInvoice = await prisma.maintenanceInvoice.aggregate({
          where: { tenantId, deletedAt: null },
          _sum: { totalAmount: true, paidAmount: true },
        });

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

      // 3. Resident View (Personalized flat details)
      const resident = await prisma.resident.findFirst({
        where: { userId: req.user!.id, tenantId, deletedAt: null },
        include: { flat: true },
      });

      if (!resident) {
        return ApiResponse.error(res, 'Resident profile not found', null, 404);
      }

      const personalComplaints = await prisma.complaint.count({
        where: { raisedBy: req.user!.id, tenantId, deletedAt: null },
      });

      const personalPendingBills = await prisma.maintenanceInvoice.count({
        where: { flatId: resident.flatId || '', tenantId, status: { in: ['UNPAID', 'PARTIALLY_PAID'] }, deletedAt: null },
      });

      const visitorPasses = await prisma.visitor.count({
        where: { preApprovedBy: resident.id, tenantId },
      });

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
