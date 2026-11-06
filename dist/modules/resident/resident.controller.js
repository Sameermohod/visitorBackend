"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ResidentController = void 0;
const security_1 = require("../../middleware/security");
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const zod_1 = require("zod");
const db_1 = __importDefault(require("../../configs/db"));
const apiResponse_1 = __importDefault(require("../../utils/apiResponse"));
const logger_1 = __importDefault(require("../../configs/logger"));
const pagination_1 = require("../../utils/pagination");
const emailService_1 = require("../../utils/emailService");
const auth_1 = require("../../middleware/auth");
const residentOnboardSchema = zod_1.z.object({
    email: zod_1.z.string().email(),
    firstName: zod_1.z.string().min(1),
    lastName: zod_1.z.string().min(1),
    phoneNumber: zod_1.z.string().min(10),
    flatId: zod_1.z.string().uuid(),
    ownershipStatus: zod_1.z.enum(['OWNER', 'TENANT']),
    // Optional: set the first password yourself; blank falls back to the default temporary password
    password: security_1.strongPassword.optional().or(zod_1.z.literal('')),
    // Only someone with users:edit (the Society Admin) may appoint a Society Secretary
    societyRole: zod_1.z.enum(['Resident', 'Society Secretary']).optional(),
    familyMembers: zod_1.z.array(zod_1.z.object({
        name: zod_1.z.string().min(1),
        phone: zod_1.z.string().optional(),
        relation: zod_1.z.string().min(1),
    })).optional().default([]),
    emergencyContacts: zod_1.z.array(zod_1.z.object({
        name: zod_1.z.string().min(1),
        phone: zod_1.z.string().min(10),
        relation: zod_1.z.string().min(1),
    })).optional().default([]),
});
const DEFAULT_TEMP_PASSWORD = 'welcome123';
const SECRETARY_ROLE = 'Society Secretary';
const canAssignRoles = (req) => req.user?.role === 'Super Admin' || !!req.permissions?.includes('users:edit');
const roleChangeSchema = zod_1.z.object({ role: zod_1.z.enum(['Resident', SECRETARY_ROLE]) });
class ResidentController {
    // Onboard new resident
    static async onboard(req, res, next) {
        try {
            const tenantId = req.tenantId;
            const data = residentOnboardSchema.parse(req.body);
            // Verify flat is registered
            const flat = await db_1.default.flat.findUnique({
                where: { id: data.flatId, tenantId, deletedAt: null },
            });
            if (!flat) {
                return apiResponse_1.default.error(res, 'Flat structure not found under tenant.', 404);
            }
            // Check if user already exists
            let user = await db_1.default.user.findFirst({
                where: { email: data.email, tenantId, deletedAt: null },
            });
            const requestedRole = data.societyRole ?? 'Resident';
            if (requestedRole !== 'Resident' && !canAssignRoles(req)) {
                return apiResponse_1.default.error(res, 'Only the Society Admin can appoint a Society Secretary.', null, 403);
            }
            const residentRole = await db_1.default.role.findUnique({
                where: { name: requestedRole },
            });
            if (!residentRole) {
                return apiResponse_1.default.error(res, `${requestedRole} role is not set up yet. Run: npm run prisma:seed:rbac`, null, 500);
            }
            // Hash outside the transaction so the CPU-bound work doesn't hold a DB connection open
            const tempPassword = data.password || DEFAULT_TEMP_PASSWORD;
            const isNewUser = !user;
            const tempPasswordHash = user ? null : await bcryptjs_1.default.hash(tempPassword, 10);
            // Wrap in a database transaction
            const result = await db_1.default.$transaction(async (tx) => {
                if (!user) {
                    // Create credentials profile
                    user = await tx.user.create({
                        data: {
                            tenantId,
                            email: data.email,
                            passwordHash: tempPasswordHash,
                            firstName: data.firstName,
                            lastName: data.lastName,
                            phoneNumber: data.phoneNumber,
                            roleId: residentRole.id,
                            isVerified: true,
                            mustChangePassword: true, // they are asked to pick their own password after first login
                            createdBy: req.user?.id,
                        },
                    });
                }
                // Check if user is already onboarded as resident in this flat
                const existingResident = await tx.resident.findFirst({
                    where: { userId: user.id, flatId: data.flatId, deletedAt: null },
                });
                if (existingResident) {
                    throw new Error('This user is already onboarded as a resident in this flat.');
                }
                // Create Resident link
                const resident = await tx.resident.create({
                    data: {
                        tenantId,
                        userId: user.id,
                        flatId: data.flatId,
                        ownershipStatus: data.ownershipStatus,
                        familyMembers: data.familyMembers,
                        emergencyContacts: data.emergencyContacts,
                    },
                });
                return resident;
            });
            // Fetch tenant details for email template
            const tenant = await db_1.default.tenant.findUnique({
                where: { id: tenantId },
            });
            if (tenant) {
                (0, emailService_1.sendEmail)(data.email, `Welcome to Your New Home! 🔑 SaaS Resident Registration`, (0, emailService_1.getResidentOnboardTemplate)(data.firstName, data.lastName, tenant.name, tenant.slug, data.email, isNewUser ? tempPassword : null)).catch((err) => logger_1.default.error('SMTP: Failed to trigger resident onboarding email:', err));
            }
            return apiResponse_1.default.success(res, result, isNewUser
                ? 'Resident added. A temporary password was emailed to them and they will be asked to change it after signing in.'
                : 'Resident added to the flat. They can sign in with their existing password.', 201);
        }
        catch (error) {
            if (error.message.includes('already onboarded')) {
                return apiResponse_1.default.error(res, error.message, null, 400);
            }
            next(error);
        }
    }
    // Appoint or remove a Society Secretary (Resident <-> Society Secretary). Requires users:edit.
    static async changeRole(req, res, next) {
        try {
            const tenantId = req.tenantId;
            const { role } = roleChangeSchema.parse(req.body);
            const resident = await db_1.default.resident.findFirst({ relationLoadStrategy: 'join',
                where: { id: req.params.residentId, tenantId, deletedAt: null },
                select: { user: { select: { id: true, firstName: true, lastName: true, role: { select: { name: true } } } } },
            });
            if (!resident?.user) {
                return apiResponse_1.default.error(res, 'Resident not found.', null, 404);
            }
            // Never touch admins, guards, staff etc. through this endpoint
            if (!['Resident', SECRETARY_ROLE].includes(resident.user.role.name)) {
                return apiResponse_1.default.error(res, `${resident.user.role.name} accounts cannot be changed here.`, null, 400);
            }
            const newRole = await db_1.default.role.findUnique({ where: { name: role } });
            if (!newRole) {
                return apiResponse_1.default.error(res, `${role} role is not set up yet. Run: npm run prisma:seed:rbac`, null, 500);
            }
            await db_1.default.user.update({ where: { id: resident.user.id }, data: { roleId: newRole.id, updatedBy: req.user?.id } });
            auth_1.userCache.invalidate(resident.user.id);
            logger_1.default.info(`Residents: ${req.user?.email} set ${resident.user.firstName} ${resident.user.lastName} to ${role}.`);
            return apiResponse_1.default.success(res, { role }, role === SECRETARY_ROLE ? 'Appointed as Society Secretary.' : 'Secretary role removed.');
        }
        catch (error) {
            next(error);
        }
    }
    // Get active residents directory
    static async getDirectory(req, res, next) {
        try {
            const tenantId = req.tenantId;
            const q = req.query.q?.trim();
            const residents = await db_1.default.resident.findMany({ relationLoadStrategy: 'join',
                where: {
                    tenantId,
                    deletedAt: null,
                    ...(q ? {
                        OR: [
                            { user: { firstName: { contains: q, mode: 'insensitive' } } },
                            { user: { lastName: { contains: q, mode: 'insensitive' } } },
                            { user: { email: { contains: q, mode: 'insensitive' } } },
                            { flat: { number: { contains: q, mode: 'insensitive' } } },
                        ],
                    } : {}),
                },
                include: {
                    user: {
                        select: {
                            id: true,
                            email: true,
                            firstName: true,
                            lastName: true,
                            phoneNumber: true,
                            avatarUrl: true,
                            aiChatDisabled: true,
                            messagingDisabled: true,
                            role: { select: { name: true } },
                        },
                    },
                    flat: {
                        include: {
                            wing: {
                                include: {
                                    building: true,
                                },
                            },
                        },
                    },
                },
                ...(0, pagination_1.getPagination)(req),
            });
            return apiResponse_1.default.success(res, residents, 'Residents directory successfully loaded');
        }
        catch (error) {
            next(error);
        }
    }
}
exports.ResidentController = ResidentController;
exports.default = ResidentController;
