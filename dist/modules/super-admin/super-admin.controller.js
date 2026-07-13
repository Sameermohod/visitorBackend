"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SuperAdminController = void 0;
const db_1 = __importDefault(require("../../configs/db"));
const apiResponse_1 = __importDefault(require("../../utils/apiResponse"));
class SuperAdminController {
    // 1. Fetch all global dashboard data with filters
    static async getGlobalData(req, res, next) {
        try {
            // Check if user is Super Admin
            if (req.user?.role !== 'Super Admin') {
                return apiResponse_1.default.error(res, 'Unauthorized. Super Admin access only.', null, 403);
            }
            const tenantId = req.query.tenantId;
            const startDate = req.query.startDate;
            const endDate = req.query.endDate;
            // 1. Fetch all active tenants/societies
            const tenants = await db_1.default.tenant.findMany({
                where: { deletedAt: null },
                orderBy: { name: 'asc' }
            });
            // 2. Fetch all users
            const users = await db_1.default.user.findMany({
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
            const staff = await db_1.default.staff.findMany({
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
            const visitorLogs = await db_1.default.visitorLog.findMany({
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
            return apiResponse_1.default.success(res, {
                tenants,
                users,
                staff,
                visitorLogs
            }, 'Global super admin data retrieved successfully');
        }
        catch (error) {
            next(error);
        }
    }
    // 2. Toggle Tenant/Society active status (suspend/unsuspend)
    static async toggleTenantStatus(req, res, next) {
        try {
            const { id } = req.params;
            const { isActive } = req.body;
            if (typeof isActive !== 'boolean') {
                return apiResponse_1.default.error(res, 'isActive status must be a boolean.', null, 400);
            }
            // Check if user is Super Admin
            if (req.user?.role !== 'Super Admin') {
                return apiResponse_1.default.error(res, 'Unauthorized. Super Admin access only.', null, 403);
            }
            const tenant = await db_1.default.tenant.findFirst({
                where: { id, deletedAt: null }
            });
            if (!tenant) {
                return apiResponse_1.default.error(res, 'Tenant/Society not found.', null, 404);
            }
            const updatedTenant = await db_1.default.tenant.update({
                where: { id },
                data: { isActive }
            });
            return apiResponse_1.default.success(res, updatedTenant, `Tenant/Society "${updatedTenant.name}" has been ${isActive ? 'activated' : 'deactivated'} successfully.`);
        }
        catch (error) {
            next(error);
        }
    }
    // 3. Delete Tenant/Society (soft-delete)
    static async deleteTenant(req, res, next) {
        try {
            const { id } = req.params;
            // Check if user is Super Admin
            if (req.user?.role !== 'Super Admin') {
                return apiResponse_1.default.error(res, 'Unauthorized. Super Admin access only.', null, 403);
            }
            const tenant = await db_1.default.tenant.findFirst({
                where: { id, deletedAt: null }
            });
            if (!tenant) {
                return apiResponse_1.default.error(res, 'Tenant/Society not found.', null, 404);
            }
            // Soft delete tenant
            const updatedTenant = await db_1.default.tenant.update({
                where: { id },
                data: {
                    deletedAt: new Date(),
                    isActive: false
                }
            });
            return apiResponse_1.default.success(res, updatedTenant, `Tenant/Society "${updatedTenant.name}" has been deleted successfully.`);
        }
        catch (error) {
            next(error);
        }
    }
    // 4. Delete user (soft-delete)
    static async deleteUser(req, res, next) {
        try {
            const { id } = req.params;
            // Check if user is Super Admin
            if (req.user?.role !== 'Super Admin') {
                return apiResponse_1.default.error(res, 'Unauthorized. Super Admin access only.', null, 403);
            }
            const user = await db_1.default.user.findFirst({
                where: { id, deletedAt: null }
            });
            if (!user) {
                return apiResponse_1.default.error(res, 'User not found.', null, 404);
            }
            // Soft delete user
            await db_1.default.user.update({
                where: { id },
                data: { deletedAt: new Date() }
            });
            return apiResponse_1.default.success(res, null, 'User deleted successfully.');
        }
        catch (error) {
            next(error);
        }
    }
    // 5. Delete staff (soft-delete)
    static async deleteStaff(req, res, next) {
        try {
            const { id } = req.params;
            // Check if user is Super Admin
            if (req.user?.role !== 'Super Admin') {
                return apiResponse_1.default.error(res, 'Unauthorized. Super Admin access only.', null, 403);
            }
            const staff = await db_1.default.staff.findFirst({
                where: { id, deletedAt: null }
            });
            if (!staff) {
                return apiResponse_1.default.error(res, 'Staff member not found.', null, 404);
            }
            // Soft delete staff
            await db_1.default.staff.update({
                where: { id },
                data: {
                    deletedAt: new Date(),
                    isActive: false
                }
            });
            return apiResponse_1.default.success(res, null, 'Staff member deleted successfully.');
        }
        catch (error) {
            next(error);
        }
    }
}
exports.SuperAdminController = SuperAdminController;
