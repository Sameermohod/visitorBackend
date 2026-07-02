import { Request, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import prisma from '../../configs/db';
import ApiResponse from '../../utils/apiResponse';
import logger from '../../configs/logger';
import { sendEmail, getAdminOnboardTemplate } from '../../utils/emailService';

// Input Validation Schemas
const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
  tenantSlug: z.string().optional(), // Nullable for global Super Admin login
});

const signupSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
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

export class AuthController {
  // Login Handler
  static async login(req: Request, res: Response, next: NextFunction) {
    try {
      const { email, password, tenantSlug } = loginSchema.parse(req.body);

      let tenantId: string | null = null;

      // Resolve tenant if slug provided
      if (tenantSlug) {
        const tenant = await prisma.tenant.findUnique({
          where: { slug: tenantSlug, deletedAt: null },
        });
        if (!tenant) {
          return ApiResponse.error(res, 'Society not registered or invalid slug.', null, 400);
        }
        if (!tenant.isActive) {
          return ApiResponse.error(res, 'This society space is suspended.', null, 403);
        }
        tenantId = tenant.id;
      }

      // Query User
      const user = await prisma.user.findFirst({
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
        return ApiResponse.error(res, 'Invalid credentials or tenant mismatch.', null, 401);
      }

      const isMatch = await bcrypt.compare(password, user.passwordHash);
      if (!isMatch) {
        return ApiResponse.error(res, 'Invalid credentials.', null, 401);
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
        process.env.JWT_ACCESS_SECRET || 'super-secret-access-token-key-change-in-prod-1290312',
        { expiresIn: (process.env.JWT_ACCESS_EXPIRY || '15m') as any }
      );

      const refreshToken = jwt.sign(
        tokenPayload,
        process.env.JWT_REFRESH_SECRET || 'super-secret-refresh-token-key-rotation-92040182',
        { expiresIn: (process.env.JWT_REFRESH_EXPIRY || '7d') as any }
      );

      // Save refresh token to user
      await prisma.user.update({
        where: { id: user.id },
        data: { refreshToken },
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
        process.env.JWT_REFRESH_SECRET || 'super-secret-refresh-token-key-rotation-92040182'
      ) as DecodedToken;

      const user = await prisma.user.findUnique({
        where: { id: decoded.userId, deletedAt: null },
        include: { role: true },
      });

      if (!user || user.refreshToken !== refreshToken) {
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
        process.env.JWT_ACCESS_SECRET || 'super-secret-access-token-key-change-in-prod-1290312',
        { expiresIn: (process.env.JWT_ACCESS_EXPIRY || '15m') as any }
      );

      const newRefreshToken = jwt.sign(
        tokenPayload,
        process.env.JWT_REFRESH_SECRET || 'super-secret-refresh-token-key-rotation-92040182',
        { expiresIn: (process.env.JWT_REFRESH_EXPIRY || '7d') as any }
      );

      // Rotate Refresh Token
      await prisma.user.update({
        where: { id: user.id },
        data: { refreshToken: newRefreshToken },
      });

      return ApiResponse.success(res, {
        accessToken: newAccessToken,
        refreshToken: newRefreshToken,
      }, 'Token refreshed successfully');
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
