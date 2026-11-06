"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SuperAdminController = void 0;
const db_1 = __importDefault(require("../../configs/db"));
const apiResponse_1 = __importDefault(require("../../utils/apiResponse"));
const tenant_1 = require("../../middleware/tenant");
const auth_1 = require("../../middleware/auth");
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
            // The four lookups are independent, so run them in parallel.
            // Sensitive columns (password hashes, refresh tokens, AI API keys) are never selected.
            const tenantSummary = { select: { id: true, name: true, slug: true } };
            const [tenants, users, staff, visitorLogs] = await Promise.all([
                // 1. All active tenants/societies
                db_1.default.tenant.findMany({
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
                db_1.default.user.findMany({ relationLoadStrategy: 'join',
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
                db_1.default.staff.findMany({ relationLoadStrategy: 'join',
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
                db_1.default.visitorLog.findMany({ relationLoadStrategy: 'join',
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
            tenant_1.tenantCache.clear();
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
            tenant_1.tenantCache.clear();
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
            auth_1.userCache.invalidate(id);
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
