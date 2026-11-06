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
const crypto_1 = require("crypto");
const secrets_1 = require("../../configs/secrets");
const security_1 = require("../../middleware/security");
const auth_1 = require("../../middleware/auth");
// The database keeps only a fingerprint of the refresh token, so a leaked database cannot be used to sign in
const fingerprint = (token) => (0, crypto_1.createHash)('sha256').update(token).digest('hex');
const same = (a, b) => a.length === b.length && (0, crypto_1.timingSafeEqual)(Buffer.from(a), Buffer.from(b));
// Compared against when the email is unknown, so a wrong email and a wrong password take the same time
const DUMMY_HASH = bcryptjs_1.default.hashSync('not-a-real-password', 10);
// Input Validation Schemas
const loginSchema = zod_1.z.object({
    email: zod_1.z.string().email().max(254),
    password: zod_1.z.string().min(1).max(128),
    tenantSlug: zod_1.z.string().optional(), // Nullable for global Super Admin login
});
console.log("loginSchema", loginSchema);
const signupSchema = zod_1.z.object({
    email: zod_1.z.string().email().max(254),
    password: security_1.strongPassword,
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
const changePasswordSchema = zod_1.z.object({
    currentPassword: zod_1.z.string().min(1, 'Enter your current password.'),
    newPassword: security_1.strongPassword,
});
class AuthController {
    // Login Handler
    static async login(req, res, next) {
        try {
            const { email: rawEmail, password } = loginSchema.parse(req.body);
            const email = rawEmail.trim();
            const lockKey = email.toLowerCase();
            const lock = (0, security_1.lockState)(lockKey);
            if (lock.locked) {
                res.setHeader('Retry-After', String(Math.ceil(lock.retryInMs / 1000)));
                return apiResponse_1.default.error(res, `Too many wrong passwords. Try again in ${Math.ceil(lock.retryInMs / 60000)} minute(s).`, null, 429);
            }
            // Query User globally by email first to find their tenant context automatically
            const user = await db_1.default.user.findFirst({
                where: {
                    email,
                    deletedAt: null,
                },
                include: {
                    role: true,
                    tenant: true,
                },
            });
            // Always run one password check, so an unknown email is not faster to answer than a wrong password
            const isMatch = await bcryptjs_1.default.compare(password, user?.passwordHash ?? DUMMY_HASH);
            if (!user || !user.passwordHash || !isMatch) {
                (0, security_1.recordFailure)(lockKey);
                logger_1.default.warn(`Auth: failed sign-in for ${lockKey} from ${req.ip}`);
                return apiResponse_1.default.error(res, 'Invalid credentials.', null, 401);
            }
            (0, security_1.clearFailures)(lockKey);
            // Only someone who knows the password learns that the society is suspended
            if (user.tenant && !user.tenant.isActive) {
                return apiResponse_1.default.error(res, 'This society space is suspended. Please contact Super Admin.', null, 403);
            }
            // Generate JWT Tokens
            const tokenPayload = {
                userId: user.id,
                email: user.email,
                role: user.role.name,
                tenantId: user.tenantId,
            };
            const accessToken = jsonwebtoken_1.default.sign(tokenPayload, (0, secrets_1.accessSecret)(), { expiresIn: (process.env.JWT_ACCESS_EXPIRY || '15m') });
            const refreshToken = jsonwebtoken_1.default.sign(tokenPayload, (0, secrets_1.refreshSecret)(), { expiresIn: (process.env.JWT_REFRESH_EXPIRY || '7d') });
            // Save a fingerprint of the refresh token to the user
            await db_1.default.user.update({
                where: { id: user.id },
                data: { refreshToken: fingerprint(refreshToken) },
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
                    mustChangePassword: user.mustChangePassword,
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
            const decoded = jsonwebtoken_1.default.verify(refreshToken, (0, secrets_1.refreshSecret)());
            const user = await db_1.default.user.findUnique({
                where: { id: decoded.userId, deletedAt: null },
                include: { role: true },
            });
            // Tokens saved before fingerprints were introduced are still accepted once, and replaced below
            const stored = user?.refreshToken ?? '';
            if (!user || !stored || !(same(stored, fingerprint(refreshToken)) || same(stored, refreshToken))) {
                return apiResponse_1.default.error(res, 'Invalid or rotated session token.', null, 401);
            }
            // Generate new tokens
            const tokenPayload = {
                userId: user.id,
                email: user.email,
                role: user.role.name,
                tenantId: user.tenantId,
            };
            const newAccessToken = jsonwebtoken_1.default.sign(tokenPayload, (0, secrets_1.accessSecret)(), { expiresIn: (process.env.JWT_ACCESS_EXPIRY || '15m') });
            const newRefreshToken = jsonwebtoken_1.default.sign(tokenPayload, (0, secrets_1.refreshSecret)(), { expiresIn: (process.env.JWT_REFRESH_EXPIRY || '7d') });
            // Rotate Refresh Token
            await db_1.default.user.update({
                where: { id: user.id },
                data: { refreshToken: fingerprint(newRefreshToken) },
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
    // Change own password (also clears the "must change password" flag set when an admin created the account)
    static async changePassword(req, res, next) {
        try {
            if (!req.user) {
                return apiResponse_1.default.error(res, 'Unauthorized', null, 401);
            }
            const { currentPassword, newPassword } = changePasswordSchema.parse(req.body);
            const user = await db_1.default.user.findUnique({
                where: { id: req.user.id },
                select: { passwordHash: true },
            });
            if (!user || !(await bcryptjs_1.default.compare(currentPassword, user.passwordHash))) {
                return apiResponse_1.default.error(res, 'Current password is incorrect.', null, 400);
            }
            if (currentPassword === newPassword) {
                return apiResponse_1.default.error(res, 'Choose a new password that is different from the current one.', null, 400);
            }
            // A new password ends every other session: the old refresh token stops working, this device gets a fresh pair
            const payload = { userId: req.user.id, email: req.user.email, role: req.user.role, tenantId: req.user.tenantId };
            const accessToken = jsonwebtoken_1.default.sign(payload, (0, secrets_1.accessSecret)(), { expiresIn: (process.env.JWT_ACCESS_EXPIRY || '15m') });
            const refreshToken = jsonwebtoken_1.default.sign(payload, (0, secrets_1.refreshSecret)(), { expiresIn: (process.env.JWT_REFRESH_EXPIRY || '7d') });
            await db_1.default.user.update({
                where: { id: req.user.id },
                data: { passwordHash: await bcryptjs_1.default.hash(newPassword, 12), mustChangePassword: false, refreshToken: fingerprint(refreshToken) },
            });
            auth_1.userCache.invalidate(req.user.id);
            logger_1.default.info(`Auth: User ${req.user.email} changed their password.`);
            return apiResponse_1.default.success(res, { accessToken, refreshToken }, 'Password updated.');
        }
        catch (error) {
            next(error);
        }
    }
    // Long-lived token for connecting an AI app (MCP). It can do everything this user can, so keep it secret.
    static async createMcpToken(req, res, next) {
        try {
            if (!req.user)
                return apiResponse_1.default.error(res, 'Unauthorized', null, 401);
            if (req.user.aiChatDisabled) {
                return apiResponse_1.default.error(res, 'AI access has been turned off for your account by the society office.', null, 403);
            }
            const { days } = zod_1.z.object({ days: zod_1.z.number().int().min(1).max(90).default(30) }).parse(req.body ?? {});
            const token = jsonwebtoken_1.default.sign({ userId: req.user.id, email: req.user.email, role: req.user.role, tenantId: req.user.tenantId, type: 'mcp' }, (0, secrets_1.accessSecret)(), { expiresIn: `${days}d` });
            logger_1.default.info(`Auth: ${req.user.email} created a ${days}-day MCP token.`);
            return apiResponse_1.default.success(res, { token, expiresAt: new Date(Date.now() + days * 86400000).toISOString(), days }, 'Connection token created.');
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
