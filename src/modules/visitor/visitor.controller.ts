import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import prisma from '../../configs/db';
import ApiResponse from '../../utils/apiResponse';
import logger from '../../configs/logger';
import { sendEmail, getVisitorGateAlertTemplate } from '../../utils/emailService';

const preApproveSchema = z.object({
  name: z.string().min(1),
  phoneNumber: z.string().min(10),
  visitorType: z.enum(['GUEST', 'DELIVERY', 'CAB', 'SERVICE_PROVIDER']),
  vehicleNumber: z.string().optional(),
  company: z.string().optional(),
  purpose: z.string().optional(),
  validFrom: z.string().datetime(),
  validUntil: z.string().datetime(),
});

const guardCheckInSchema = z.object({
  visitorId: z.string().uuid(),
  flatId: z.preprocess(
    (val) => (typeof val === 'string' && val.length === 36 ? val : undefined),
    z.string().uuid().optional()
  ),
  notes: z.string().optional().default('Checked in at main gate'),
});

const faceEnrollSchema = z.object({
  visitorName: z.string().min(1),
  faceImageBase64: z.string().min(100), // Enrolls base64 face vector
});

const manualEntrySchema = z.object({
  name: z.string().min(1),
  phoneNumber: z.string().min(10),
  visitorType: z.enum(['GUEST', 'DELIVERY', 'CAB']),
  company: z.string().optional(),
  vehicleNumber: z.string().optional(),
  flatId: z.string().uuid(),
  purpose: z.string().optional(),
  notes: z.string().optional(),
});

export class VisitorController {
  // Guard Walk-in Manual Entry check-in
  static async manualEntry(req: Request, res: Response, next: NextFunction) {
    try {
      const tenantId = req.tenantId!;
      const guardId = req.user!.id;
      const data = manualEntrySchema.parse(req.body);

      const result = await prisma.$transaction(async (tx) => {
        // 1. Create a Visitor record marked as APPROVED
        const visitor = await tx.visitor.create({
          data: {
            tenantId,
            name: data.name,
            phoneNumber: data.phoneNumber,
            visitorType: data.visitorType,
            company: data.company,
            vehicleNumber: data.vehicleNumber,
            purpose: data.purpose || 'Manual Entry by Guard',
            status: 'APPROVED',
          },
        });

        // 2. Create the VisitorLog entry immediately
        const log = await tx.visitorLog.create({
          data: {
            tenantId,
            visitorId: visitor.id,
            flatId: data.flatId,
            checkedInBy: guardId,
            notes: data.notes || 'Manual walk-in check-in completed at gate',
          },
        });

        return { visitor, log };
      });

      // Fetch the full log to return to client
      const fullLog = await prisma.visitorLog.findUnique({
        where: { id: result.log.id },
        include: { visitor: true, flat: true },
      });

      // Asynchronously fetch occupants and notify them via SMTP email alerts
      prisma.resident.findMany({
        where: { flatId: data.flatId, tenantId, deletedAt: null },
        include: {
          user: true,
          flat: true,
        },
      }).then((flatOccupants) => {
        if (flatOccupants && flatOccupants.length > 0 && fullLog) {
          const flatNumber = flatOccupants[0].flat?.number || 'your flat';
          for (const occ of flatOccupants) {
            if (occ.user && occ.user.email) {
              sendEmail(
                occ.user.email,
                `🚨 Gate Security: Manual Visitor Checked In at Main Entrance`,
                getVisitorGateAlertTemplate(
                  fullLog.visitor.name,
                  fullLog.visitor.visitorType,
                  fullLog.visitor.vehicleNumber,
                  fullLog.visitor.purpose,
                  flatNumber,
                  new Date().toLocaleString()
                )
              ).catch((err) => logger.error(`SMTP: Failed to notify resident ${occ.user.email} of manual visitor check-in:`, err));
            }
          }
        }
      }).catch((err) => logger.error('SMTP: Failed to query flat occupants for manual visitor alert:', err));

      logger.info(`Guard: Manual visitor entry created for ${data.name} to flat ${data.flatId}`);
      return ApiResponse.success(res, fullLog, 'Manual entry check-in completed successfully.', 201);
    } catch (error) {
      next(error);
    }
  }

  // Pre-approve guest (Resident only)
  static async preApprove(req: Request, res: Response, next: NextFunction) {
    try {
      const tenantId = req.tenantId!;
      const data = preApproveSchema.parse(req.body);

      // Verify user is resident
      const resident = await prisma.resident.findFirst({
        where: { userId: req.user?.id, tenantId, deletedAt: null },
      });

      if (!resident) {
        return ApiResponse.error(res, 'Only verified residents can pre-approve guests.', null, 403);
      }

      // Generate a dynamic, unique secure QR string token
      const qrToken = `PASS-${tenantId.slice(0, 4)}-${Math.random().toString(36).substring(2, 8).toUpperCase()}`;

      const visitor = await prisma.visitor.create({
        data: {
          tenantId,
          name: data.name,
          phoneNumber: data.phoneNumber,
          visitorType: data.visitorType,
          vehicleNumber: data.vehicleNumber,
          company: data.company,
          purpose: data.purpose,
          qrCode: qrToken,
          preApprovedBy: resident.id,
          validFrom: new Date(data.validFrom),
          validUntil: new Date(data.validUntil),
          status: 'PRE_APPROVED',
        },
      });

      return ApiResponse.success(res, visitor, 'Guest pre-approved. QR pass generated successfully', 201);
    } catch (error) {
      next(error);
    }
  }

  // Get active visitor logs
  static async getLogs(req: Request, res: Response, next: NextFunction) {
    try {
      const tenantId = req.tenantId!;
      const logs = await prisma.visitorLog.findMany({
        where: { tenantId },
        include: {
          visitor: true,
          flat: {
            include: {
              wing: {
                include: {
                  building: true,
                },
              },
            },
          },
          guardIn: {
            select: { firstName: true, lastName: true },
          },
        },
        orderBy: { checkedInAt: 'desc' },
      });

      return ApiResponse.success(res, logs, 'Visitor logs loaded successfully');
    } catch (error) {
      next(error);
    }
  }

  // Get active pre-approvals for Resident
  static async getMyPreApprovals(req: Request, res: Response, next: NextFunction) {
    try {
      const tenantId = req.tenantId!;
      
      const resident = await prisma.resident.findFirst({
        where: { userId: req.user?.id, tenantId, deletedAt: null },
      });

      if (!resident) {
        return ApiResponse.error(res, 'Resident profile not found', null, 404);
      }

      const preApprovals = await prisma.visitor.findMany({
        where: { tenantId, preApprovedBy: resident.id },
        orderBy: { createdAt: 'desc' },
      });

      return ApiResponse.success(res, preApprovals, 'Pre-approvals loaded successfully');
    } catch (error) {
      next(error);
    }
  }

  // Guard QR code verification check
  static async verifyPass(req: Request, res: Response, next: NextFunction) {
    try {
      const tenantId = req.tenantId!;
      let qrCode = req.query.qrCode as string;
      
      if (qrCode) {
        qrCode = qrCode.trim();
      }

      if (!qrCode) {
        return ApiResponse.error(res, 'Missing QR code query parameter', null, 400);
      }

      const visitor = await prisma.visitor.findFirst({
        where: { tenantId, qrCode },
        include: {
          resident: {
            include: {
              user: true,
              flat: true,
            },
          },
        },
      });

      if (!visitor) {
        return ApiResponse.error(res, 'Invalid QR code. Access denied.', null, 404);
      }

      const now = new Date();
      if (visitor.validFrom && now < visitor.validFrom) {
        return ApiResponse.error(res, 'Pass is not active yet. Valid from: ' + visitor.validFrom.toISOString(), null, 400);
      }
      if (visitor.validUntil && now > visitor.validUntil) {
        return ApiResponse.error(res, 'Pass has expired. Access denied.', null, 400);
      }

      return ApiResponse.success(res, visitor, 'Pass is VALID. Entry ready to check-in.');
    } catch (error) {
      next(error);
    }
  }

  // Guard Check-in calling PostgreSQL Stored Procedure `procedure_log_visitor_entry`
  static async checkIn(req: Request, res: Response, next: NextFunction) {
    try {
      const tenantId = req.tenantId!;
      const guardUserId = req.user!.id;
      let { visitorId, flatId, notes } = guardCheckInSchema.parse(req.body);

      // Automatically resolve flatId from database if not provided/invalid
      if (!flatId) {
        const visitor = await prisma.visitor.findFirst({
          where: { id: visitorId, tenantId },
          include: {
            resident: true,
          },
        });
        if (visitor && visitor.resident && visitor.resident.flatId) {
          flatId = visitor.resident.flatId;
        } else {
          return ApiResponse.error(res, 'Target resident flat details could not be resolved for this visitor. Please specify a valid flatId UUID.', null, 400);
        }
      }

      logger.info(`Visitor: Executing CALL procedure_log_visitor_entry on DB for tenant: ${tenantId}`);

      // Execute Stored Procedure
      await prisma.$executeRawUnsafe(
        `CALL procedure_log_visitor_entry($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::text, NULL::uuid)`,
        tenantId,
        visitorId,
        flatId,
        guardUserId,
        notes
      );

      // Fetch the newly logged entry to return to client
      const latestLog = await prisma.visitorLog.findFirst({
        where: { tenantId, visitorId, flatId },
        orderBy: { checkedInAt: 'desc' },
        include: { visitor: true, flat: true },
      });

      // Asynchronously fetch occupants and notify them via SMTP email alerts
      prisma.resident.findMany({
        where: { flatId, tenantId, deletedAt: null },
        include: {
          user: true,
          flat: true,
        },
      }).then((flatOccupants) => {
        if (flatOccupants && flatOccupants.length > 0 && latestLog) {
          const flatNumber = flatOccupants[0].flat?.number || 'your flat';
          for (const occ of flatOccupants) {
            if (occ.user && occ.user.email) {
              sendEmail(
                occ.user.email,
                `🚨 Gate Security: Visitor Checked In at Main Entrance`,
                getVisitorGateAlertTemplate(
                  latestLog.visitor.name,
                  latestLog.visitor.visitorType,
                  latestLog.visitor.vehicleNumber,
                  latestLog.visitor.purpose,
                  flatNumber,
                  new Date().toLocaleString()
                )
              ).catch((err) => logger.error(`SMTP: Failed to notify resident ${occ.user.email} of visitor check-in:`, err));
            }
          }
        }
      }).catch((err) => logger.error('SMTP: Failed to query flat occupants for visitor alert:', err));

      return ApiResponse.success(res, latestLog, 'Visitor checked in successfully via stored procedure', 201);
    } catch (error) {
      next(error);
    }
  }

  // Check-out Visitor
  static async checkOut(req: Request, res: Response, next: NextFunction) {
    try {
      const tenantId = req.tenantId!;
      const guardUserId = req.user!.id;
      const logId = req.params.logId;

      const log = await prisma.visitorLog.findUnique({
        where: { id: logId, tenantId },
      });

      if (!log) {
        return ApiResponse.error(res, 'Visitor entry log not found.', null, 404);
      }

      const result = await prisma.$transaction(async (tx) => {
        // Update Visitor status
        await tx.visitor.update({
          where: { id: log.visitorId },
          data: { status: 'DEPARTED' },
        });

        // Update Log timestamps
        return tx.visitorLog.update({
          where: { id: logId },
          data: {
            checkedOutAt: new Date(),
            checkedOutBy: guardUserId,
          },
          include: { visitor: true },
        });
      });

      return ApiResponse.success(res, result, 'Visitor checked out successfully');
    } catch (error) {
      next(error);
    }
  }

  // Face Recognition visitor enrolment (Advanced Future Ready placeholder integration)
  static async enrollFace(req: Request, res: Response, next: NextFunction) {
    try {
      const tenantId = req.tenantId!;
      const data = faceEnrollSchema.parse(req.body);

      // Simulation of feature vector extraction
      const faceToken = `FACE-VEC-${Math.random().toString(36).substring(2, 10).toUpperCase()}`;

      return ApiResponse.success(res, {
        visitorName: data.visitorName,
        enrolledToken: faceToken,
        matchConfidence: 0.99,
        status: 'ENROLLED_SUCCESS'
      }, 'Biometric Face data enrolled successfully');
    } catch (error) {
      next(error);
    }
  }

  // Delete pre-approved pass (Resident only can delete their own passes)
  static async deletePass(req: Request, res: Response, next: NextFunction) {
    try {
      const tenantId = req.tenantId!;
      const passId = req.params.passId;
      const userRole = req.user!.role;
      const userId = req.user!.id;

      if (userRole === 'Resident') {
        const resident = await prisma.resident.findFirst({
          where: { userId, tenantId, deletedAt: null },
        });
        if (!resident) {
          return ApiResponse.error(res, 'Resident profile not found', null, 404);
        }

        const visitor = await prisma.visitor.findFirst({
          where: { id: passId, tenantId },
        });

        if (!visitor) {
          return ApiResponse.error(res, 'Visitor pass not found', null, 404);
        }

        if (visitor.preApprovedBy !== resident.id) {
          return ApiResponse.error(res, 'Access denied: you can only delete passes created by you.', null, 403);
        }
      } else if (userRole !== 'Society Admin' && userRole !== 'Super Admin') {
        return ApiResponse.error(res, 'Access denied: unauthorized.', null, 403);
      }

      // Delete the visitor pass
      await prisma.visitor.delete({
        where: { id: passId },
      });

      return ApiResponse.success(res, null, 'Visitor pass deleted successfully');
    } catch (error) {
      next(error);
    }
  }
}
export default VisitorController;
