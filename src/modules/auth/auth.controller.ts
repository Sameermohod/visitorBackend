import { Request, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import prisma from '../../configs/db';
import ApiResponse from '../../utils/apiResponse';
import logger from '../../configs/logger';
import { sendEmail, getAdminOnboardTemplate } from '../../utils/emailService';
import { createHash, timingSafeEqual } from 'crypto';
import { accessSecret, refreshSecret } from '../../configs/secrets';
import { clearFailures, lockState, recordFailure, strongPassword } from '../../middleware/security';
import { userCache } from '../../middleware/auth';

// The database keeps only a fingerprint of the refresh token, so a leaked database cannot be used to sign in
const fingerprint = (token: string) => createHash('sha256').update(token).digest('hex');
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
// Compared against when the email is unknown, so a wrong email and a wrong password take the same time
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);


// Input Validation Schemas
const loginSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(128),
  tenantSlug: z.string().optional(), // Nullable for global Super Admin login
});

const signupSchema = z.object({
  email: z.string().email().max(254),
  password: strongPassword,
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  phoneNumber: z.string().optional(),
  tenantName: z.string().min(3),
  tenantSlug: z.string().min(3).regex(/^[a-z0-9-]+$/),
  subscriptionTier: z.enum(['BASIC', 'PREMIUM', 'ENTERPRISE']).default('BASIC'),
});

const refreshSchema = z.object({
  refreshToken: z.string(),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Enter your current password.'),
  newPassword: strongPassword,
});

export class AuthController {
  // Login Handler
  static async login(req: Request, res: Response, next: NextFunction) {
    try {
      const { email: rawEmail, password } = loginSchema.parse(req.body);
      const email = rawEmail.trim();
      const lockKey = email.toLowerCase();
      const lock = lockState(lockKey);
      if (lock.locked) {
        res.setHeader('Retry-After', String(Math.ceil(lock.retryInMs / 1000)));
        return ApiResponse.error(res, `Too many wrong passwords. Try again in ${Math.ceil(lock.retryInMs / 60000)} minute(s).`, null, 429);
      }

      // Query User globally by email first to find their tenant context automatically
      const user = await prisma.user.findFirst({
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
      const isMatch = await bcrypt.compare(password, user?.passwordHash ?? DUMMY_HASH);
      if (!user || !user.passwordHash || !isMatch) {
        recordFailure(lockKey);
        logger.warn(`Auth: failed sign-in for ${lockKey} from ${req.ip}`);
        return ApiResponse.error(res, 'Invalid credentials.', null, 401);
      }
      clearFailures(lockKey);

      // Only someone who knows the password learns that the society is suspended
      if (user.tenant && !user.tenant.isActive) {
        return ApiResponse.error(res, 'This society space is suspended. Please contact Super Admin.', null, 403);
      }

      // Generate JWT Tokens
      const tokenPayload = {
        userId: user.id,
        email: user.email,
        role: user.role.name,
        tenantId: user.tenantId,
      };

      const accessToken = jwt.sign(
        tokenPayload,
        accessSecret(),
        { expiresIn: (process.env.JWT_ACCESS_EXPIRY || '15m') as any }
      );

      const refreshToken = jwt.sign(
        tokenPayload,
        refreshSecret(),
        { expiresIn: (process.env.JWT_REFRESH_EXPIRY || '7d') as any }
      );

      // Save a fingerprint of the refresh token to the user
      await prisma.user.update({
        where: { id: user.id },
        data: { refreshToken: fingerprint(refreshToken) },
      });

      logger.info(`Auth: User ${email} logged in successfully.`);

      return ApiResponse.success(res, {
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
    } catch (error) {
      next(error);
    }
  }

  // Tenant / Multi-Tenant Admin Onboarding Signup
  static async signup(req: Request, res: Response, next: NextFunction) {
    try {
      const data = signupSchema.parse(req.body);

      // Check if tenant slug is taken
      const existingTenant = await prisma.tenant.findUnique({
        where: { slug: data.tenantSlug },
      });
      if (existingTenant) {
        return ApiResponse.error(res, 'Tenant subdomain/slug is already taken.', null, 400);
      }

      // Resolve dynamic role "Society Admin"
      const adminRole = await prisma.role.findUnique({
        where: { name: 'Society Admin' },
      });
      if (!adminRole) {
        return ApiResponse.error(res, 'Internal role settings not loaded. Seed system.', null, 500);
      }

      // Resolve subscription model mapping
      const subscription = await prisma.subscription.findFirst({
        where: { tier: data.subscriptionTier },
      });

      // Wrap in a transaction to guarantee data integrity
      const result = await prisma.$transaction(async (tx) => {
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
        const salt = await bcrypt.genSalt(10);
        const passwordHash = await bcrypt.hash(data.password, salt);

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
      sendEmail(
        data.email,
        'Welcome to SaaS Society! 🏢 Your Workspace is Initialized',
        getAdminOnboardTemplate(data.firstName, data.tenantName, data.tenantSlug, data.email)
      ).catch((err) => logger.error('SMTP: Failed to trigger admin onboarding email:', err));

      logger.info(`Auth: New tenant ${data.tenantSlug} created successfully by ${data.email}.`);

      return ApiResponse.success(
        res,
        {
          tenant: result.tenant,
          adminUser: {
            id: result.adminUser.id,
            email: result.adminUser.email,
            firstName: result.adminUser.firstName,
            lastName: result.adminUser.lastName,
          },
        },
        'Tenant registered and admin user created successfully',
        201
      );
    } catch (error) {
      next(error);
    }
  }

  // Refresh Token Rotation
  static async refresh(req: Request, res: Response, next: NextFunction) {
    try {
      const { refreshToken } = refreshSchema.parse(req.body);

      // Verify token
      const decoded = jwt.verify(
        refreshToken,
        refreshSecret()
      ) as DecodedToken;

      const user = await prisma.user.findUnique({
        where: { id: decoded.userId, deletedAt: null },
        include: { role: true },
      });

      // Tokens saved before fingerprints were introduced are still accepted once, and replaced below
      const stored = user?.refreshToken ?? '';
      if (!user || !stored || !(same(stored, fingerprint(refreshToken)) || same(stored, refreshToken))) {
        return ApiResponse.error(res, 'Invalid or rotated session token.', null, 401);
      }

      // Generate new tokens
      const tokenPayload = {
        userId: user.id,
        email: user.email,
        role: user.role.name,
        tenantId: user.tenantId,
      };

      const newAccessToken = jwt.sign(
        tokenPayload,
        accessSecret(),
        { expiresIn: (process.env.JWT_ACCESS_EXPIRY || '15m') as any }
      );

      const newRefreshToken = jwt.sign(
        tokenPayload,
        refreshSecret(),
        { expiresIn: (process.env.JWT_REFRESH_EXPIRY || '7d') as any }
      );

      // Rotate Refresh Token
      await prisma.user.update({
        where: { id: user.id },
        data: { refreshToken: fingerprint(newRefreshToken) },
      });

      return ApiResponse.success(res, {
        accessToken: newAccessToken,
        refreshToken: newRefreshToken,
      }, 'Token refreshed successfully');
    } catch (error) {
      next(error);
    }
  }

  // Change own password (also clears the "must change password" flag set when an admin created the account)
  static async changePassword(req: Request, res: Response, next: NextFunction) {
    try {
      if (!req.user) {
        return ApiResponse.error(res, 'Unauthorized', null, 401);
      }
      const { currentPassword, newPassword } = changePasswordSchema.parse(req.body);

      const user = await prisma.user.findUnique({
        where: { id: req.user.id },
        select: { passwordHash: true },
      });
      if (!user || !(await bcrypt.compare(currentPassword, user.passwordHash))) {
        return ApiResponse.error(res, 'Current password is incorrect.', null, 400);
      }
      if (currentPassword === newPassword) {
        return ApiResponse.error(res, 'Choose a new password that is different from the current one.', null, 400);
      }

      // A new password ends every other session: the old refresh token stops working, this device gets a fresh pair
      const payload = { userId: req.user.id, email: req.user.email, role: req.user.role, tenantId: req.user.tenantId };
      const accessToken = jwt.sign(payload, accessSecret(), { expiresIn: (process.env.JWT_ACCESS_EXPIRY || '15m') as any });
      const refreshToken = jwt.sign(payload, refreshSecret(), { expiresIn: (process.env.JWT_REFRESH_EXPIRY || '7d') as any });
      await prisma.user.update({
        where: { id: req.user.id },
        data: { passwordHash: await bcrypt.hash(newPassword, 12), mustChangePassword: false, refreshToken: fingerprint(refreshToken) },
      });
      userCache.invalidate(req.user.id);

      logger.info(`Auth: User ${req.user.email} changed their password.`);
      return ApiResponse.success(res, { accessToken, refreshToken }, 'Password updated.');
    } catch (error) {
      next(error);
    }
  }

  // Long-lived token for connecting an AI app (MCP). It can do everything this user can, so keep it secret.
  static async createMcpToken(req: Request, res: Response, next: NextFunction) {
    try {
      if (!req.user) return ApiResponse.error(res, 'Unauthorized', null, 401);
      if (req.user.aiChatDisabled) {
        return ApiResponse.error(res, 'AI access has been turned off for your account by the society office.', null, 403);
      }
      const { days } = z.object({ days: z.number().int().min(1).max(90).default(30) }).parse(req.body ?? {});

      const token = jwt.sign(
        { userId: req.user.id, email: req.user.email, role: req.user.role, tenantId: req.user.tenantId, type: 'mcp' },
        accessSecret(),
        { expiresIn: `${days}d` }
      );
      logger.info(`Auth: ${req.user.email} created a ${days}-day MCP token.`);
      return ApiResponse.success(res, { token, expiresAt: new Date(Date.now() + days * 86400000).toISOString(), days }, 'Connection token created.');
    } catch (error) {
      next(error);
    }
  }

  // Log Out / Clear session token
  static async logout(req: Request, res: Response, next: NextFunction) {
    try {
      if (!req.user) {
        return ApiResponse.error(res, 'Unauthorized', null, 401);
      }

      await prisma.user.update({
        where: { id: req.user.id },
        data: { refreshToken: null },
      });

      return ApiResponse.success(res, null, 'Logged out successfully');
    } catch (error) {
      next(error);
    }
  }
}

interface DecodedToken {
  userId: string;
  email: string;
  role: string;
  tenantId: string | null;
}
export default AuthController;
