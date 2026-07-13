import { Request, Response, NextFunction } from 'express';
import prisma from '../../configs/db';
import ApiResponse from '../../utils/apiResponse';

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
      const tenants = await prisma.tenant.findMany({
        where: { deletedAt: null },
        orderBy: { name: 'asc' }
      });

      // 2. Fetch all users
      const users = await prisma.user.findMany({
        where: {
          deletedAt: null,
          ...(tenantId ? { tenantId } : {})
        },
        include: {
          role: true,
          tenant: true
        },
        orderBy: { createdAt: 'desc' }
      });

      // 3. Fetch all staff members
      const staff = await prisma.staff.findMany({
        where: {
          deletedAt: null,
          ...(tenantId ? { tenantId } : {})
        },
        include: {
          tenant: true
        },
        orderBy: { createdAt: 'desc' }
      });

      // 4. Fetch all visitor logs with date range and society filters
      const visitorLogs = await prisma.visitorLog.findMany({
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
          tenant: true,
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
        orderBy: { checkedInAt: 'desc' }
      });

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
