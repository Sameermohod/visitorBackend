"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AnalyticsController = void 0;
const db_1 = __importDefault(require("../../configs/db"));
const apiResponse_1 = __importDefault(require("../../utils/apiResponse"));
class AnalyticsController {
    // Main Dashboard Metrics resolving dynamically based on User Role
    static async getDashboardStats(req, res, next) {
        try {
            const userRole = req.user.role;
            const tenantId = req.tenantId;
            // 1. Super Admin View (Multi-Tenant SaaS Overview)
            if (userRole === 'Super Admin') {
                const totalTenants = await db_1.default.tenant.count({ where: { deletedAt: null } });
                const activeTenants = await db_1.default.tenant.count({ where: { isActive: true, deletedAt: null } });
                const subscriptions = await db_1.default.subscription.findMany();
                const tenantsDetails = await db_1.default.tenant.findMany({
                    where: { deletedAt: null },
                    include: {
                        subscription: true,
                    },
                });
                return apiResponse_1.default.success(res, {
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
                const totalResidents = await db_1.default.resident.count({ where: { tenantId, deletedAt: null } });
                const totalGuards = await db_1.default.staff.count({ where: { tenantId, type: 'Guard', deletedAt: null } });
                const openComplaints = await db_1.default.complaint.count({ where: { tenantId, status: 'OPEN', deletedAt: null } });
                const resolvedComplaints = await db_1.default.complaint.count({ where: { tenantId, status: 'RESOLVED', deletedAt: null } });
                const visitorsToday = await db_1.default.visitorLog.count({
                    where: {
                        tenantId,
                        checkedInAt: {
                            gte: new Date(new Date().setHours(0, 0, 0, 0)),
                        },
                    },
                });
                // Financial collection ratios
                const aggregateInvoice = await db_1.default.maintenanceInvoice.aggregate({
                    where: { tenantId, deletedAt: null },
                    _sum: { totalAmount: true, paidAmount: true },
                });
                const totalBilled = Number(aggregateInvoice._sum.totalAmount || 0);
                const totalCollected = Number(aggregateInvoice._sum.paidAmount || 0);
                return apiResponse_1.default.success(res, {
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
            const resident = await db_1.default.resident.findFirst({
                where: { userId: req.user.id, tenantId, deletedAt: null },
                include: { flat: true },
            });
            if (!resident) {
                return apiResponse_1.default.error(res, 'Resident profile not found', null, 404);
            }
            const personalComplaints = await db_1.default.complaint.count({
                where: { raisedBy: req.user.id, tenantId, deletedAt: null },
            });
            const personalPendingBills = await db_1.default.maintenanceInvoice.count({
                where: { flatId: resident.flatId || '', tenantId, status: { in: ['UNPAID', 'PARTIALLY_PAID'] }, deletedAt: null },
            });
            const visitorPasses = await db_1.default.visitor.count({
                where: { preApprovedBy: resident.id, tenantId },
            });
            return apiResponse_1.default.success(res, {
                view: 'RESIDENT',
                flatDetails: resident.flat,
                stats: {
                    myComplaintsCount: personalComplaints,
                    myPendingBillsCount: personalPendingBills,
                    myVisitorPassesCount: visitorPasses,
                },
            }, 'Resident profile analytics loaded');
        }
        catch (error) {
            next(error);
        }
    }
}
exports.AnalyticsController = AnalyticsController;
exports.default = AnalyticsController;
