"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ResidentController = void 0;
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const zod_1 = require("zod");
const db_1 = __importDefault(require("../../configs/db"));
const apiResponse_1 = __importDefault(require("../../utils/apiResponse"));
const logger_1 = __importDefault(require("../../configs/logger"));
const emailService_1 = require("../../utils/emailService");
const residentOnboardSchema = zod_1.z.object({
    email: zod_1.z.string().email(),
    firstName: zod_1.z.string().min(1),
    lastName: zod_1.z.string().min(1),
    phoneNumber: zod_1.z.string().min(10),
    flatId: zod_1.z.string().uuid(),
    ownershipStatus: zod_1.z.enum(['OWNER', 'TENANT']),
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
            const residentRole = await db_1.default.role.findUnique({
                where: { name: 'Resident' },
            });
            if (!residentRole) {
                return apiResponse_1.default.error(res, 'Resident role definitions are not seeded.', 500);
            }
            // Wrap in a database transaction
            const result = await db_1.default.$transaction(async (tx) => {
                if (!user) {
                    // Create credentials profile
                    const salt = await bcryptjs_1.default.genSalt(10);
                    const tempPasswordHash = await bcryptjs_1.default.hash('welcome123', salt); // Default login credentials
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
            });
            // Fetch tenant details for email template
            const tenant = await db_1.default.tenant.findUnique({
                where: { id: tenantId },
            });
            if (tenant) {
                (0, emailService_1.sendEmail)(data.email, `Welcome to Your New Home! 🔑 SaaS Resident Registration`, (0, emailService_1.getResidentOnboardTemplate)(data.firstName, data.lastName, tenant.name, tenant.slug, data.email)).catch((err) => logger_1.default.error('SMTP: Failed to trigger resident onboarding email:', err));
            }
            return apiResponse_1.default.success(res, result, 'Resident onboarded successfully. Default credentials set: email/welcome123', 201);
        }
        catch (error) {
            if (error.message.includes('already onboarded')) {
                return apiResponse_1.default.error(res, error.message, null, 400);
            }
            next(error);
        }
    }
    // Get active residents directory
    static async getDirectory(req, res, next) {
        try {
            const tenantId = req.tenantId;
            const residents = await db_1.default.resident.findMany({
                where: { tenantId, deletedAt: null },
                include: {
                    user: {
                        select: {
                            id: true,
                            email: true,
                            firstName: true,
                            lastName: true,
                            phoneNumber: true,
                            avatarUrl: true,
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
