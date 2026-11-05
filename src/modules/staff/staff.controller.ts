import { Request, Response, NextFunction } from 'express';
import { strongPassword } from '../../middleware/security';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import prisma from '../../configs/db';
import ApiResponse from '../../utils/apiResponse';
import logger from '../../configs/logger';
import { getPagination } from '../../utils/pagination';
import { availabilityFor } from '../../services/staffAvailability';
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
  // Optional: set the first password yourself; blank falls back to the default temporary password
  password: strongPassword.optional().or(z.literal('')),
});

const DEFAULT_TEMP_PASSWORD = 'welcome123';

export class StaffController {
  // Onboard guard or staff member
  static async onboard(req: Request, res: Response, next: NextFunction) {
    try {
      const tenantId = req.tenantId!;
      const data = staffOnboardSchema.parse(req.body);

      // Verify that if role is Guard, an email is provided to create credentials
      const isGuard = data.type.toLowerCase().includes('guard');
      const email = data.email || (isGuard ? `${data.firstName.toLowerCase()}.${data.lastName.toLowerCase()}@guard.com` : undefined);

      // Hash outside the transaction so the CPU-bound work doesn't hold a DB connection open
      const tempPassword = data.password || DEFAULT_TEMP_PASSWORD;
      const tempPasswordHash = email ? await bcrypt.hash(tempPassword, 10) : null;

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

          user = await tx.user.create({
            data: {
              tenantId,
              email,
              passwordHash: tempPasswordHash!,
              firstName: data.firstName,
              lastName: data.lastName,
              phoneNumber: data.phoneNumber,
              roleId: role.id,
              isVerified: true,
              mustChangePassword: true, // they are asked to pick their own password after first login
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
            getStaffOnboardTemplate(data.firstName, data.lastName, data.type, tenant.name, tenant.slug, result.email, tempPassword)
          ).catch((err) => logger.error('SMTP: Failed to trigger staff onboarding email:', err));
        }
      }

      logger.info(`Staff: Staff ${data.firstName} ${data.lastName} onboarded successfully.`);

      return ApiResponse.success(
        res,
        result.staff,
        result.email 
          ? `Staff member added. A temporary password was emailed to ${result.email} and they will be asked to change it after signing in.`
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

      // Residents may see who the technicians are (to pick one for a complaint) but not salaries or logins
      const fullAccess = req.user!.role === 'Super Admin' || !!req.permissions?.includes('staff:manage');
      if (!fullAccess) {
        const team = await prisma.staff.findMany({
          where: { tenantId, deletedAt: null, isActive: true },
          select: { id: true, firstName: true, lastName: true, type: true, phoneNumber: true, isActive: true, onLeaveFrom: true, onLeaveUntil: true, leaveReason: true },
          orderBy: { firstName: 'asc' },
          ...getPagination(req),
        });
        const avail = await availabilityFor(tenantId, team);
        return ApiResponse.success(
          res,
          team.map(({ onLeaveFrom, onLeaveUntil, leaveReason, ...s }) => ({ ...s, ...avail.get(s.id) })),
          'Staff registry successfully loaded'
        );
      }

      const staffMembers = await prisma.staff.findMany({ relationLoadStrategy: 'join',
        where: { tenantId, deletedAt: null },
        include: {
          user: {
            select: {
              id: true,
              email: true,
              isVerified: true,
              aiChatDisabled: true,
              messagingDisabled: true,
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
        ...getPagination(req),
      });

      // Each person's status for assigning work: Available, Busy (with queue length) or On leave
      const avail = await availabilityFor(tenantId, staffMembers);
      return ApiResponse.success(res, staffMembers.map((s) => ({ ...s, ...avail.get(s.id) })), 'Staff registry successfully loaded');
    } catch (error) {
      next(error);
    }
  }

  // Mark someone as on leave between two dates (they cannot be given complaints while away)
  static async setLeave(req: Request, res: Response, next: NextFunction) {
    try {
      const tenantId = req.tenantId!;
      const data = z.object({
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        reason: z.string().max(200).optional(),
      }).parse(req.body);

      const from = new Date(data.from ?? new Date().toISOString().slice(0, 10));
      const until = new Date(data.until);
      if (until < from) return ApiResponse.error(res, 'The leave cannot end before it starts.', null, 400);

      const staff = await prisma.staff.findFirst({ where: { id: req.params.staffId, tenantId, deletedAt: null } });
      if (!staff) return ApiResponse.error(res, 'Staff member not found.', null, 404);

      await prisma.staff.update({ where: { id: staff.id }, data: { onLeaveFrom: from, onLeaveUntil: until, leaveReason: data.reason || null } });

      // Complaints they are holding need someone else: tell the user so they can reassign
      const holding = await prisma.complaint.count({
        where: { tenantId, deletedAt: null, assignedTo: staff.id, status: { in: ['OPEN', 'IN_PROGRESS'] } },
      });
      return ApiResponse.success(
        res,
        { holding },
        holding ? `${staff.firstName} is on leave. They still hold ${holding} open complaint(s): reassign them.` : `${staff.firstName} is marked as on leave until ${data.until}.`
      );
    } catch (error) {
      next(error);
    }
  }

  static async clearLeave(req: Request, res: Response, next: NextFunction) {
    try {
      const staff = await prisma.staff.findFirst({ where: { id: req.params.staffId, tenantId: req.tenantId!, deletedAt: null } });
      if (!staff) return ApiResponse.error(res, 'Staff member not found.', null, 404);
      await prisma.staff.update({ where: { id: staff.id }, data: { onLeaveFrom: null, onLeaveUntil: null, leaveReason: null } });
      return ApiResponse.success(res, null, `${staff.firstName} is back from leave.`);
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
