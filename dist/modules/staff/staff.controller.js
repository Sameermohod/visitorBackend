"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.StaffController = void 0;
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const zod_1 = require("zod");
const db_1 = __importDefault(require("../../configs/db"));
const apiResponse_1 = __importDefault(require("../../utils/apiResponse"));
const logger_1 = __importDefault(require("../../configs/logger"));
const emailService_1 = require("../../utils/emailService");
const staffOnboardSchema = zod_1.z.object({
    firstName: zod_1.z.string().min(1),
    lastName: zod_1.z.string().min(1),
    phoneNumber: zod_1.z.string().min(10),
    type: zod_1.z.string().min(1), // Guard, Plumber, Electrician, Cleaner, etc.
    salaryMonthly: zod_1.z.number().optional(),
    shiftStart: zod_1.z.string().optional().default('08:00'),
    shiftEnd: zod_1.z.string().optional().default('20:00'),
    email: zod_1.z.string().email().optional(), // Nullable for normal staff, required for Guards who need to log in
});
class StaffController {
    // Onboard guard or staff member
    static async onboard(req, res, next) {
        try {
            const tenantId = req.tenantId;
            const data = staffOnboardSchema.parse(req.body);
            // Verify that if role is Guard, an email is provided to create credentials
            const isGuard = data.type.toLowerCase().includes('guard');
            const email = data.email || (isGuard ? `${data.firstName.toLowerCase()}.${data.lastName.toLowerCase()}@guard.com` : undefined);
            // Wrap staff creation in a database transaction
            const result = await db_1.default.$transaction(async (tx) => {
                let createdUserId = null;
                // If email is provided, create a credential profile
                if (email) {
                    // Resolve role
                    const targetRoleName = isGuard ? 'Security Guard' : 'Maintenance Staff';
                    const role = await tx.role.findUnique({
                        where: { name: targetRoleName },
                    });
                    if (!role) {
                        throw new Error(`${targetRoleName} role definitions are not seeded.`);
                    }
                    // Check if user already exists
                    let user = await tx.user.findFirst({
                        where: { email, tenantId, deletedAt: null },
                    });
                    if (user) {
                        throw new Error(`A user with the email "${email}" already exists under this tenant.`);
                    }
                    // Generate default login credentials
                    const salt = await bcryptjs_1.default.genSalt(10);
                    const tempPasswordHash = await bcryptjs_1.default.hash('welcome123', salt);
                    user = await tx.user.create({
                        data: {
                            tenantId,
                            email,
                            passwordHash: tempPasswordHash,
                            firstName: data.firstName,
                            lastName: data.lastName,
                            phoneNumber: data.phoneNumber,
                            roleId: role.id,
                            isVerified: true,
                            createdBy: req.user?.id,
                        },
                    });
                    createdUserId = user.id;
                }
                // Create Staff Record
                const staff = await tx.staff.create({
                    data: {
                        tenantId,
                        userId: createdUserId,
                        firstName: data.firstName,
                        lastName: data.lastName,
                        phoneNumber: data.phoneNumber,
                        type: data.type,
                        salaryMonthly: data.salaryMonthly,
                        shiftStart: data.shiftStart,
                        shiftEnd: data.shiftEnd,
                    },
                });
                return { staff, email };
            });
            // If a login email is created, fetch tenant details and send welcome credentials email
            if (result.email) {
                const tenant = await db_1.default.tenant.findUnique({
                    where: { id: tenantId },
                });
                if (tenant) {
                    (0, emailService_1.sendEmail)(result.email, `Welcome to SaaS Society! 🛠️ Staff Login Configured`, (0, emailService_1.getStaffOnboardTemplate)(data.firstName, data.lastName, data.type, tenant.name, tenant.slug, result.email)).catch((err) => logger_1.default.error('SMTP: Failed to trigger staff onboarding email:', err));
                }
            }
            logger_1.default.info(`Staff: Staff ${data.firstName} ${data.lastName} onboarded successfully.`);
            return apiResponse_1.default.success(res, result.staff, result.email
                ? `Staff onboarded successfully. Credentials created: email: ${result.email}, password: welcome123`
                : 'Staff onboarded successfully without login profile.', 201);
        }
        catch (error) {
            if (error.message.includes('already exists') || error.message.includes('not seeded')) {
                return apiResponse_1.default.error(res, error.message, null, 400);
            }
            next(error);
        }
    }
    // Get active staff and guard registry
    static async getDirectory(req, res, next) {
        try {
            const tenantId = req.tenantId;
            const staffMembers = await db_1.default.staff.findMany({
                where: { tenantId, deletedAt: null },
                include: {
                    user: {
                        select: {
                            id: true,
                            email: true,
                            isVerified: true,
                            role: {
                                select: {
                                    name: true,
                                },
                            },
                        },
                    },
                },
                orderBy: {
                    createdAt: 'desc',
                },
            });
            return apiResponse_1.default.success(res, staffMembers, 'Staff registry successfully loaded');
        }
        catch (error) {
            next(error);
        }
    }
    // Toggle staff active/inactive state
    static async toggleActive(req, res, next) {
        try {
            const tenantId = req.tenantId;
            const staffId = req.params.staffId;
            const { isActive } = zod_1.z.object({ isActive: zod_1.z.boolean() }).parse(req.body);
            const staff = await db_1.default.staff.findFirst({
                where: { id: staffId, tenantId, deletedAt: null },
            });
            if (!staff) {
                return apiResponse_1.default.error(res, 'Staff member not found.', null, 404);
            }
            const updated = await db_1.default.staff.update({
                where: { id: staffId },
                data: { isActive },
            });
            logger_1.default.info(`Staff: Toggled staff ${staff.firstName} ${staff.lastName} active status to: ${isActive}`);
            return apiResponse_1.default.success(res, updated, `Staff status successfully updated to ${isActive ? 'Active' : 'Inactive'}`);
        }
        catch (error) {
            next(error);
        }
    }
}
exports.StaffController = StaffController;
exports.default = StaffController;
