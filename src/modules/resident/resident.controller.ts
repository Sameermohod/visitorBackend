import { Request, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import prisma from '../../configs/db';
import ApiResponse from '../../utils/apiResponse';
import logger from '../../configs/logger';
import { sendEmail, getResidentOnboardTemplate } from '../../utils/emailService';

const residentOnboardSchema = z.object({
  email: z.string().email(),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  phoneNumber: z.string().min(10),
  flatId: z.string().uuid(),
  ownershipStatus: z.enum(['OWNER', 'TENANT']),
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

      const residentRole = await prisma.role.findUnique({
        where: { name: 'Resident' },
      });

      if (!residentRole) {
        return ApiResponse.error(res, 'Resident role definitions are not seeded.', 500);
      }

      // Wrap in a database transaction
      const result = await prisma.$transaction(async (tx) => {
        if (!user) {
          // Create credentials profile
          const salt = await bcrypt.genSalt(10);
          const tempPasswordHash = await bcrypt.hash('welcome123', salt); // Default login credentials

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
      const tenant = await prisma.tenant.findUnique({
        where: { id: tenantId },
      });

      if (tenant) {
        sendEmail(
          data.email,
          `Welcome to Your New Home! 🔑 SaaS Resident Registration`,
          getResidentOnboardTemplate(data.firstName, data.lastName, tenant.name, tenant.slug, data.email)
        ).catch((err) => logger.error('SMTP: Failed to trigger resident onboarding email:', err));
      }

      return ApiResponse.success(res, result, 'Resident onboarded successfully. Default credentials set: email/welcome123', 201);
    } catch (error: any) {
      if (error.message.includes('already onboarded')) {
        return ApiResponse.error(res, error.message, null, 400);
      }
      next(error);
    }
  }

  // Get active residents directory
  static async getDirectory(req: Request, res: Response, next: NextFunction) {
    try {
      const tenantId = req.tenantId!;

      const residents = await prisma.resident.findMany({
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

      return ApiResponse.success(res, residents, 'Residents directory successfully loaded');
    } catch (error) {
      next(error);
    }
  }
}
export default ResidentController;
