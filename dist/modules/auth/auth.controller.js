"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AuthController = void 0;
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const zod_1 = require("zod");
const db_1 = __importDefault(require("../../configs/db"));
const apiResponse_1 = __importDefault(require("../../utils/apiResponse"));
const logger_1 = __importDefault(require("../../configs/logger"));
const emailService_1 = require("../../utils/emailService");
// Input Validation Schemas
const loginSchema = zod_1.z.object({
    email: zod_1.z.string().email(),
    password: zod_1.z.string().min(6),
    tenantSlug: zod_1.z.string().optional(), // Nullable for global Super Admin login
});
const signupSchema = zod_1.z.object({
    email: zod_1.z.string().email(),
    password: zod_1.z.string().min(6),
    firstName: zod_1.z.string().min(1),
    lastName: zod_1.z.string().min(1),
    phoneNumber: zod_1.z.string().optional(),
    tenantName: zod_1.z.string().min(3),
    tenantSlug: zod_1.z.string().min(3).regex(/^[a-z0-9-]+$/),
    subscriptionTier: zod_1.z.enum(['BASIC', 'PREMIUM', 'ENTERPRISE']).default('BASIC'),
});
const refreshSchema = zod_1.z.object({
    refreshToken: zod_1.z.string(),
});
class AuthController {
    // Login Handler
    static async login(req, res, next) {
        try {
            const { email, password, tenantSlug } = loginSchema.parse(req.body);
            let tenantId = null;
            // Resolve tenant if slug provided
            if (tenantSlug) {
                const tenant = await db_1.default.tenant.findUnique({
                    where: { slug: tenantSlug, deletedAt: null },
                });
                if (!tenant) {
                    return apiResponse_1.default.error(res, 'Society not registered or invalid slug.', null, 400);
                }
                if (!tenant.isActive) {
                    return apiResponse_1.default.error(res, 'This society space is suspended.', null, 403);
                }
                tenantId = tenant.id;
            }
            // Query User
            const user = await db_1.default.user.findFirst({
                where: {
                    email,
                    tenantId,
                    deletedAt: null,
                },
                include: {
                    role: true,
                    tenant: true,
                },
            });
            if (!user) {
                return apiResponse_1.default.error(res, 'Invalid credentials or tenant mismatch.', null, 401);
            }
            const isMatch = await bcryptjs_1.default.compare(password, user.passwordHash);
            if (!isMatch) {
                return apiResponse_1.default.error(res, 'Invalid credentials.', null, 401);
            }
            // Generate JWT Tokens
            const tokenPayload = {
                userId: user.id,
                email: user.email,
                role: user.role.name,
                tenantId: user.tenantId,
            };
            const accessToken = jsonwebtoken_1.default.sign(tokenPayload, process.env.JWT_ACCESS_SECRET || 'super-secret-access-token-key-change-in-prod-1290312', { expiresIn: (process.env.JWT_ACCESS_EXPIRY || '15m') });
            const refreshToken = jsonwebtoken_1.default.sign(tokenPayload, process.env.JWT_REFRESH_SECRET || 'super-secret-refresh-token-key-rotation-92040182', { expiresIn: (process.env.JWT_REFRESH_EXPIRY || '7d') });
            // Save refresh token to user
            await db_1.default.user.update({
                where: { id: user.id },
                data: { refreshToken },
            });
            logger_1.default.info(`Auth: User ${email} logged in successfully.`);
            return apiResponse_1.default.success(res, {
                accessToken,
                refreshToken,
                user: {
                    id: user.id,
                    email: user.email,
                    firstName: user.firstName,
                    lastName: user.lastName,
                    role: user.role.name,
                    tenantId: user.tenantId,
                    tenant: user.tenant ? {
                        id: user.tenant.id,
                        name: user.tenant.name,
                        slug: user.tenant.slug,
                    } : null,
                },
            }, 'Login successful');
        }
        catch (error) {
            next(error);
        }
    }
    // Tenant / Multi-Tenant Admin Onboarding Signup
    static async signup(req, res, next) {
        try {
            const data = signupSchema.parse(req.body);
            // Check if tenant slug is taken
            const existingTenant = await db_1.default.tenant.findUnique({
                where: { slug: data.tenantSlug },
            });
            if (existingTenant) {
                return apiResponse_1.default.error(res, 'Tenant subdomain/slug is already taken.', null, 400);
            }
            // Resolve dynamic role "Society Admin"
            const adminRole = await db_1.default.role.findUnique({
                where: { name: 'Society Admin' },
            });
            if (!adminRole) {
                return apiResponse_1.default.error(res, 'Internal role settings not loaded. Seed system.', null, 500);
            }
            // Resolve subscription model mapping
            const subscription = await db_1.default.subscription.findFirst({
                where: { tier: data.subscriptionTier },
            });
            // Wrap in a transaction to guarantee data integrity
            const result = await db_1.default.$transaction(async (tx) => {
                // Create Tenant Space
                const tenant = await tx.tenant.create({
                    data: {
                        name: data.tenantName,
                        slug: data.tenantSlug,
                        subscriptionId: subscription?.id || null,
                        trialEndsAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 Days Trial
                    },
                });
                // Create Default Society structural mapping inside Tenant
                const society = await tx.society.create({
                    data: {
                        tenantId: tenant.id,
                        name: data.tenantName,
                        address: 'Default Society Address',
                        city: 'Metro City',
                        state: 'State Land',
                        zipCode: '100001',
                    },
                });
                // Create Default Building Tower structural mapping inside Society
                await tx.building.create({
                    data: {
                        tenantId: tenant.id,
                        societyId: society.id,
                        name: 'Main Building Tower',
                        wingsCount: 1,
                    },
                });
                // Create Admin User Account
                const salt = await bcryptjs_1.default.genSalt(10);
                const passwordHash = await bcryptjs_1.default.hash(data.password, salt);
                const adminUser = await tx.user.create({
                    data: {
                        tenantId: tenant.id,
                        email: data.email,
                        passwordHash,
                        firstName: data.firstName,
                        lastName: data.lastName,
                        phoneNumber: data.phoneNumber,
                        roleId: adminRole.id,
                        isVerified: true,
                    },
                });
                return { tenant, adminUser };
            });
            // Asynchronously trigger welcome onboarding email
            (0, emailService_1.sendEmail)(data.email, 'Welcome to SaaS Society! 🏢 Your Workspace is Initialized', (0, emailService_1.getAdminOnboardTemplate)(data.firstName, data.tenantName, data.tenantSlug, data.email)).catch((err) => logger_1.default.error('SMTP: Failed to trigger admin onboarding email:', err));
            logger_1.default.info(`Auth: New tenant ${data.tenantSlug} created successfully by ${data.email}.`);
            return apiResponse_1.default.success(res, {
                tenant: result.tenant,
                adminUser: {
                    id: result.adminUser.id,
                    email: result.adminUser.email,
                    firstName: result.adminUser.firstName,
                    lastName: result.adminUser.lastName,
                },
            }, 'Tenant registered and admin user created successfully', 201);
        }
        catch (error) {
            next(error);
        }
    }
    // Refresh Token Rotation
    static async refresh(req, res, next) {
        try {
            const { refreshToken } = refreshSchema.parse(req.body);
            // Verify token
            const decoded = jsonwebtoken_1.default.verify(refreshToken, process.env.JWT_REFRESH_SECRET || 'super-secret-refresh-token-key-rotation-92040182');
            const user = await db_1.default.user.findUnique({
                where: { id: decoded.userId, deletedAt: null },
                include: { role: true },
            });
            if (!user || user.refreshToken !== refreshToken) {
                return apiResponse_1.default.error(res, 'Invalid or rotated session token.', null, 401);
            }
            // Generate new tokens
            const tokenPayload = {
                userId: user.id,
                email: user.email,
                role: user.role.name,
                tenantId: user.tenantId,
            };
            const newAccessToken = jsonwebtoken_1.default.sign(tokenPayload, process.env.JWT_ACCESS_SECRET || 'super-secret-access-token-key-change-in-prod-1290312', { expiresIn: (process.env.JWT_ACCESS_EXPIRY || '15m') });
            const newRefreshToken = jsonwebtoken_1.default.sign(tokenPayload, process.env.JWT_REFRESH_SECRET || 'super-secret-refresh-token-key-rotation-92040182', { expiresIn: (process.env.JWT_REFRESH_EXPIRY || '7d') });
            // Rotate Refresh Token
            await db_1.default.user.update({
                where: { id: user.id },
                data: { refreshToken: newRefreshToken },
            });
            return apiResponse_1.default.success(res, {
                accessToken: newAccessToken,
                refreshToken: newRefreshToken,
            }, 'Token refreshed successfully');
        }
        catch (error) {
            next(error);
        }
    }
    // Log Out / Clear session token
    static async logout(req, res, next) {
        try {
            if (!req.user) {
                return apiResponse_1.default.error(res, 'Unauthorized', null, 401);
            }
            await db_1.default.user.update({
                where: { id: req.user.id },
                data: { refreshToken: null },
            });
            return apiResponse_1.default.success(res, null, 'Logged out successfully');
        }
        catch (error) {
            next(error);
        }
    }
}
exports.AuthController = AuthController;
exports.default = AuthController;
