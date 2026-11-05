import { Request, Response, NextFunction } from 'express';
import prisma from '../../configs/db';
import ApiResponse from '../../utils/apiResponse';
import { tenantCache } from '../../middleware/tenant';
import { userCache } from '../../middleware/auth';

export class SuperAdminController {
  // 1. Fetch all global dashboard data with filters
  static async getGlobalData(req: Request, res: Response, next: NextFunction) {
    try {
      // Check if user is Super Admin
      if (req.user?.role !== 'Super Admin') {
        return ApiResponse.error(res, 'Unauthorized. Super Admin access only.', null, 403);
      }

      const tenantId = req.query.tenantId as string | undefined;
      const startDate = req.query.startDate as string | undefined;
      const endDate = req.query.endDate as string | undefined;

      // 1. Fetch all active tenants/societies
      // The four lookups are independent, so run them in parallel.
      // Sensitive columns (password hashes, refresh tokens, AI API keys) are never selected.
      const tenantSummary = { select: { id: true, name: true, slug: true } };
      const [tenants, users, staff, visitorLogs] = await Promise.all([
        // 1. All active tenants/societies
        prisma.tenant.findMany({
          where: { deletedAt: null },
          select: {
            id: true,
            name: true,
            slug: true,
            logoUrl: true,
            themePrimary: true,
            themeSecondary: true,
            subscriptionId: true,
            subscriptionStatus: true,
            trialEndsAt: true,
            isActive: true,
            aiEnabled: true,
            aiProvider: true,
            createdAt: true,
          },
          orderBy: { name: 'asc' }
        }),

        // 2. All users
        prisma.user.findMany({ relationLoadStrategy: 'join',
          where: {
            deletedAt: null,
            ...(tenantId ? { tenantId } : {})
          },
          select: {
            id: true,
            tenantId: true,
            email: true,
            firstName: true,
            lastName: true,
            phoneNumber: true,
            isVerified: true,
            createdAt: true,
            role: { select: { id: true, name: true } },
            tenant: tenantSummary
          },
          orderBy: { createdAt: 'desc' }
        }),

        // 3. All staff members
        prisma.staff.findMany({ relationLoadStrategy: 'join',
          where: {
            deletedAt: null,
            ...(tenantId ? { tenantId } : {})
          },
          include: {
            tenant: tenantSummary
          },
          orderBy: { createdAt: 'desc' }
        }),

        // 4. Visitor logs with date range and society filters (most recent 1000)
        prisma.visitorLog.findMany({ relationLoadStrategy: 'join',
          where: {
            ...(tenantId ? { tenantId } : {}),
            ...(startDate || endDate ? {
              checkedInAt: {
                ...(startDate ? { gte: new Date(startDate) } : {}),
                ...(endDate ? { lte: new Date(endDate) } : {})
              }
            } : {})
          },
          include: {
            visitor: { select: { name: true, visitorType: true, vehicleNumber: true, company: true } },
            tenant: tenantSummary,
            flat: {
              include: {
                wing: {
                  include: {
                    building: true
                  }
                }
              }
            }
          },
          orderBy: { checkedInAt: 'desc' },
          take: 1000
        })
      ]);

      return ApiResponse.success(res, {
        tenants,
        users,
        staff,
        visitorLogs
      }, 'Global super admin data retrieved successfully');
    } catch (error) {
      next(error);
    }
  }

  // 2. Toggle Tenant/Society active status (suspend/unsuspend)
  static async toggleTenantStatus(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const { isActive } = req.body;

      if (typeof isActive !== 'boolean') {
        return ApiResponse.error(res, 'isActive status must be a boolean.', null, 400);
      }

      // Check if user is Super Admin
      if (req.user?.role !== 'Super Admin') {
        return ApiResponse.error(res, 'Unauthorized. Super Admin access only.', null, 403);
      }

      const tenant = await prisma.tenant.findFirst({
        where: { id, deletedAt: null }
      });

      if (!tenant) {
        return ApiResponse.error(res, 'Tenant/Society not found.', null, 404);
      }

      const updatedTenant = await prisma.tenant.update({
        where: { id },
        data: { isActive }
      });
      tenantCache.clear();

      return ApiResponse.success(
        res,
        updatedTenant,
        `Tenant/Society "${updatedTenant.name}" has been ${isActive ? 'activated' : 'deactivated'} successfully.`
      );
    } catch (error) {
      next(error);
    }
  }

  // 3. Delete Tenant/Society (soft-delete)
  static async deleteTenant(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;

      // Check if user is Super Admin
      if (req.user?.role !== 'Super Admin') {
        return ApiResponse.error(res, 'Unauthorized. Super Admin access only.', null, 403);
      }

      const tenant = await prisma.tenant.findFirst({
        where: { id, deletedAt: null }
      });

      if (!tenant) {
        return ApiResponse.error(res, 'Tenant/Society not found.', null, 404);
      }

      // Soft delete tenant
      const updatedTenant = await prisma.tenant.update({
        where: { id },
        data: { 
          deletedAt: new Date(),
          isActive: false
        }
      });
      tenantCache.clear();

      return ApiResponse.success(
        res,
        updatedTenant,
        `Tenant/Society "${updatedTenant.name}" has been deleted successfully.`
      );
    } catch (error) {
      next(error);
    }
  }

  // 4. Delete user (soft-delete)
  static async deleteUser(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;

      // Check if user is Super Admin
      if (req.user?.role !== 'Super Admin') {
        return ApiResponse.error(res, 'Unauthorized. Super Admin access only.', null, 403);
      }

      const user = await prisma.user.findFirst({
        where: { id, deletedAt: null }
      });

      if (!user) {
        return ApiResponse.error(res, 'User not found.', null, 404);
      }

      // Soft delete user
      await prisma.user.update({
        where: { id },
        data: { deletedAt: new Date() }
      });
      userCache.invalidate(id);

      return ApiResponse.success(res, null, 'User deleted successfully.');
    } catch (error) {
      next(error);
    }
  }

  // 5. Delete staff (soft-delete)
  static async deleteStaff(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;

      // Check if user is Super Admin
      if (req.user?.role !== 'Super Admin') {
        return ApiResponse.error(res, 'Unauthorized. Super Admin access only.', null, 403);
      }

      const staff = await prisma.staff.findFirst({
        where: { id, deletedAt: null }
      });

      if (!staff) {
        return ApiResponse.error(res, 'Staff member not found.', null, 404);
      }

      // Soft delete staff
      await prisma.staff.update({
        where: { id },
        data: { 
          deletedAt: new Date(),
          isActive: false
        }
      });

      return ApiResponse.success(res, null, 'Staff member deleted successfully.');
    } catch (error) {
      next(error);
    }
  }
}
