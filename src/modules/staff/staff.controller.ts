import { Request, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import prisma from '../../configs/db';
import ApiResponse from '../../utils/apiResponse';
import logger from '../../configs/logger';
import { sendEmail, getStaffOnboardTemplate } from '../../utils/emailService';

const staffOnboardSchema = z.object({
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  phoneNumber: z.string().min(10),
  type: z.string().min(1), // Guard, Plumber, Electrician, Cleaner, etc.
  salaryMonthly: z.number().optional(),
  shiftStart: z.string().optional().default('08:00'),
  shiftEnd: z.string().optional().default('20:00'),
  email: z.string().email().optional(), // Nullable for normal staff, required for Guards who need to log in
});

export class StaffController {
  // Onboard guard or staff member
  static async onboard(req: Request, res: Response, next: NextFunction) {
    try {
      const tenantId = req.tenantId!;
      const data = staffOnboardSchema.parse(req.body);

      // Verify that if role is Guard, an email is provided to create credentials
      const isGuard = data.type.toLowerCase().includes('guard');
      const email = data.email || (isGuard ? `${data.firstName.toLowerCase()}.${data.lastName.toLowerCase()}@guard.com` : undefined);

      // Wrap staff creation in a database transaction
      const result = await prisma.$transaction(async (tx) => {
        let createdUserId: string | null = null;

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
          const salt = await bcrypt.genSalt(10);
          const tempPasswordHash = await bcrypt.hash('welcome123', salt);

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
        const tenant = await prisma.tenant.findUnique({
          where: { id: tenantId },
        });
        if (tenant) {
          sendEmail(
            result.email,
            `Welcome to SaaS Society! 🛠️ Staff Login Configured`,
            getStaffOnboardTemplate(data.firstName, data.lastName, data.type, tenant.name, tenant.slug, result.email)
          ).catch((err) => logger.error('SMTP: Failed to trigger staff onboarding email:', err));
        }
      }

      logger.info(`Staff: Staff ${data.firstName} ${data.lastName} onboarded successfully.`);

      return ApiResponse.success(
        res,
        result.staff,
        result.email 
          ? `Staff onboarded successfully. Credentials created: email: ${result.email}, password: welcome123` 
          : 'Staff onboarded successfully without login profile.',
        201
      );
    } catch (error: any) {
      if (error.message.includes('already exists') || error.message.includes('not seeded')) {
        return ApiResponse.error(res, error.message, null, 400);
      }
      next(error);
    }
  }

  // Get active staff and guard registry
  static async getDirectory(req: Request, res: Response, next: NextFunction) {
    try {
      const tenantId = req.tenantId!;

      const staffMembers = await prisma.staff.findMany({
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

      return ApiResponse.success(res, staffMembers, 'Staff registry successfully loaded');
    } catch (error) {
      next(error);
    }
  }

  // Toggle staff active/inactive state
  static async toggleActive(req: Request, res: Response, next: NextFunction) {
    try {
      const tenantId = req.tenantId!;
      const staffId = req.params.staffId;
      const { isActive } = z.object({ isActive: z.boolean() }).parse(req.body);

      const staff = await prisma.staff.findFirst({
        where: { id: staffId, tenantId, deletedAt: null },
      });

      if (!staff) {
        return ApiResponse.error(res, 'Staff member not found.', null, 404);
      }

      const updated = await prisma.staff.update({
        where: { id: staffId },
        data: { isActive },
      });

      logger.info(`Staff: Toggled staff ${staff.firstName} ${staff.lastName} active status to: ${isActive}`);
      return ApiResponse.success(res, updated, `Staff status successfully updated to ${isActive ? 'Active' : 'Inactive'}`);
    } catch (error) {
      next(error);
    }
  }
}
export default StaffController;
