import { Request, Response, NextFunction } from 'express';
import { strongPassword } from '../../middleware/security';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import prisma from '../../configs/db';
import ApiResponse from '../../utils/apiResponse';
import logger from '../../configs/logger';
import { getPagination } from '../../utils/pagination';
import { sendEmail, getResidentOnboardTemplate } from '../../utils/emailService';
import { userCache } from '../../middleware/auth';

const residentOnboardSchema = z.object({
  email: z.string().email(),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  phoneNumber: z.string().min(10),
  flatId: z.string().uuid(),
  ownershipStatus: z.enum(['OWNER', 'TENANT']),
  // Optional: set the first password yourself; blank falls back to the default temporary password
  password: strongPassword.optional().or(z.literal('')),
  // Only someone with users:edit (the Society Admin) may appoint a Society Secretary
  societyRole: z.enum(['Resident', 'Society Secretary']).optional(),
  familyMembers: z.array(z.object({
    name: z.string().min(1),
    phone: z.string().optional(),
    relation: z.string().min(1),
  })).optional().default([]),
  emergencyContacts: z.array(z.object({
    name: z.string().min(1),
    phone: z.string().min(10),
    relation: z.string().min(1),
  })).optional().default([]),
});

const DEFAULT_TEMP_PASSWORD = 'welcome123';
const SECRETARY_ROLE = 'Society Secretary';

const canAssignRoles = (req: Request) =>
  req.user?.role === 'Super Admin' || !!req.permissions?.includes('users:edit');

const roleChangeSchema = z.object({ role: z.enum(['Resident', SECRETARY_ROLE]) });

export class ResidentController {
  // Onboard new resident
  static async onboard(req: Request, res: Response, next: NextFunction) {
    try {
      const tenantId = req.tenantId!;
      const data = residentOnboardSchema.parse(req.body);

      // Verify flat is registered
      const flat = await prisma.flat.findUnique({
        where: { id: data.flatId, tenantId, deletedAt: null },
      });
      if (!flat) {
        return ApiResponse.error(res, 'Flat structure not found under tenant.', 404);
      }

      // Check if user already exists
      let user = await prisma.user.findFirst({
        where: { email: data.email, tenantId, deletedAt: null },
      });

      const requestedRole = data.societyRole ?? 'Resident';
      if (requestedRole !== 'Resident' && !canAssignRoles(req)) {
        return ApiResponse.error(res, 'Only the Society Admin can appoint a Society Secretary.', null, 403);
      }

      const residentRole = await prisma.role.findUnique({
        where: { name: requestedRole },
      });

      if (!residentRole) {
        return ApiResponse.error(res, `${requestedRole} role is not set up yet. Run: npm run prisma:seed:rbac`, null, 500);
      }

      // Hash outside the transaction so the CPU-bound work doesn't hold a DB connection open
      const tempPassword = data.password || DEFAULT_TEMP_PASSWORD;
      const isNewUser = !user;
      const tempPasswordHash = user ? null : await bcrypt.hash(tempPassword, 10);

      // Wrap in a database transaction
      const result = await prisma.$transaction(async (tx) => {
        if (!user) {
          // Create credentials profile
          user = await tx.user.create({
            data: {
              tenantId,
              email: data.email,
              passwordHash: tempPasswordHash!,
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
      const tenant = await prisma.tenant.findUnique({
        where: { id: tenantId },
      });

      if (tenant) {
        sendEmail(
          data.email,
          `Welcome to Your New Home! 🔑 SaaS Resident Registration`,
          getResidentOnboardTemplate(data.firstName, data.lastName, tenant.name, tenant.slug, data.email, isNewUser ? tempPassword : null)
        ).catch((err) => logger.error('SMTP: Failed to trigger resident onboarding email:', err));
      }

      return ApiResponse.success(res, result, isNewUser
          ? 'Resident added. A temporary password was emailed to them and they will be asked to change it after signing in.'
          : 'Resident added to the flat. They can sign in with their existing password.', 201);
    } catch (error: any) {
      if (error.message.includes('already onboarded')) {
        return ApiResponse.error(res, error.message, null, 400);
      }
      next(error);
    }
  }

  // Appoint or remove a Society Secretary (Resident <-> Society Secretary). Requires users:edit.
  static async changeRole(req: Request, res: Response, next: NextFunction) {
    try {
      const tenantId = req.tenantId!;
      const { role } = roleChangeSchema.parse(req.body);

      const resident = await prisma.resident.findFirst({ relationLoadStrategy: 'join',
        where: { id: req.params.residentId, tenantId, deletedAt: null },
        select: { user: { select: { id: true, firstName: true, lastName: true, role: { select: { name: true } } } } },
      });
      if (!resident?.user) {
        return ApiResponse.error(res, 'Resident not found.', null, 404);
      }
      // Never touch admins, guards, staff etc. through this endpoint
      if (!['Resident', SECRETARY_ROLE].includes(resident.user.role.name)) {
        return ApiResponse.error(res, `${resident.user.role.name} accounts cannot be changed here.`, null, 400);
      }

      const newRole = await prisma.role.findUnique({ where: { name: role } });
      if (!newRole) {
        return ApiResponse.error(res, `${role} role is not set up yet. Run: npm run prisma:seed:rbac`, null, 500);
      }

      await prisma.user.update({ where: { id: resident.user.id }, data: { roleId: newRole.id, updatedBy: req.user?.id } });
      userCache.invalidate(resident.user.id);

      logger.info(`Residents: ${req.user?.email} set ${resident.user.firstName} ${resident.user.lastName} to ${role}.`);
      return ApiResponse.success(res, { role }, role === SECRETARY_ROLE ? 'Appointed as Society Secretary.' : 'Secretary role removed.');
    } catch (error) {
      next(error);
    }
  }

  // Get active residents directory
  static async getDirectory(req: Request, res: Response, next: NextFunction) {
    try {
      const tenantId = req.tenantId!;
      const q = (req.query.q as string | undefined)?.trim();

      const residents = await prisma.resident.findMany({ relationLoadStrategy: 'join',
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
        ...getPagination(req),
      });

      return ApiResponse.success(res, residents, 'Residents directory successfully loaded');
    } catch (error) {
      next(error);
    }
  }
}
export default ResidentController;
