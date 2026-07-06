import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import prisma from '../../configs/db';
import ApiResponse from '../../utils/apiResponse';
import logger from '../../configs/logger';
import { sendEmail, getComplaintUpdateTemplate } from '../../utils/emailService';

const complaintCreateSchema = z.object({
  title: z.string().min(3),
  description: z.string().min(10),
  priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']).default('MEDIUM'),
  attachments: z.array(z.string()).optional().default([]),
  staffId: z.string().uuid().optional(),
});

const assignSchema = z.object({
  staffId: z.string().uuid(),
});

const commentSchema = z.object({
  comment: z.string().min(1),
  attachments: z.array(z.string()).optional().default([]),
});

export class ComplaintController {
  // Raise Complaint Ticket with Automatic AI Categorizer
  static async raiseComplaint(req: Request, res: Response, next: NextFunction) {
    try {
      const tenantId = req.tenantId!;
      const data = complaintCreateSchema.parse(req.body);
      const residentId = req.user!.id;

      // 1. AI NLP Heuristic Categorization
      let category = 'GENERAL';
      const textToAnalyze = `${data.title} ${data.description}`.toLowerCase();

      if (/\b(leak|water|pipe|clog|tap|plumb|flush)\b/g.test(textToAnalyze)) {
        category = 'PLUMBING';
      } else if (/\b(wire|light|power|electric|spark|fuse|mcb|switch|bulb)\b/g.test(textToAnalyze)) {
        category = 'ELECTRICAL';
      } else if (/\b(lift|elevator|escalator|lobby|gate|door|gym)\b/g.test(textToAnalyze)) {
        category = 'INFRASTRUCTURE';
      } else if (/\b(guard|thief|intruder|camera|cctv|lock|security|theft)\b/g.test(textToAnalyze)) {
        category = 'SAFETY';
      }

      // 2. SLA Due Date calculation based on Priority
      const now = new Date();
      let slaDue = new Date(now);

      if (data.priority === 'URGENT') {
        slaDue.setHours(now.getHours() + 4); // 4 Hours SLA
      } else if (data.priority === 'HIGH') {
        slaDue.setDate(now.getDate() + 1); // 24 Hours SLA
      } else if (data.priority === 'MEDIUM') {
        slaDue.setDate(now.getDate() + 3); // 3 Days SLA
      } else {
        slaDue.setDate(now.getDate() + 5); // 5 Days SLA
      }

      // 3. Generate unique ticket number: TIC-TENANT-RANDOM
      const ticketNumber = `TIC-${tenantId.slice(0, 4)}-${Math.floor(100000 + Math.random() * 900000)}`;

      // 4. Handle staff assignment directly during creation
      let assignedTo: string | null = null;
      let status: 'OPEN' | 'IN_PROGRESS' = 'OPEN';
      let staff: any = null;

      if (data.staffId) {
        staff = await prisma.staff.findUnique({
          where: { id: data.staffId, tenantId, deletedAt: null },
        });
        if (!staff) {
          return ApiResponse.error(res, 'Maintenance staff member not found.', null, 404);
        }
        assignedTo = data.staffId;
        status = 'IN_PROGRESS';
      }

      const complaint = await prisma.complaint.create({
        data: {
          tenantId,
          ticketNumber,
          raisedBy: residentId,
          title: data.title,
          description: data.description,
          category,
          priority: data.priority,
          slaDue,
          attachments: data.attachments,
          status,
          assignedTo,
        },
      });

      // Asynchronously send ticket receipt email to Resident
      prisma.user.findUnique({
        where: { id: residentId },
      }).then((user) => {
        if (user && user.email) {
          const actionText = staff
            ? `Ticket successfully created and assigned to ${staff.firstName} ${staff.lastName} (${staff.type}). Work is in progress.`
            : `Ticket successfully created. AI auto-assigned to ${category} department. SLA target: ${data.priority} priority.`;
          sendEmail(
            user.email,
            staff 
              ? `🛠️ Complaint Filed & Assigned: Ticket ${ticketNumber}`
              : `📝 Complaint Filed: Ticket ${ticketNumber} is OPEN`,
            getComplaintUpdateTemplate(
              user.firstName,
              ticketNumber,
              data.title,
              status,
              category,
              actionText
            )
          ).catch((err) => logger.error(`SMTP: Failed to send complaint ticket receipt email to ${user.email}:`, err));
        }
      }).catch((err) => logger.error('SMTP: Failed to query user for complaint receipt:', err));

      // Asynchronously send assignment task email to staff if assigned during creation
      if (staff && staff.userId) {
        prisma.user.findUnique({
          where: { id: staff.userId },
        }).then((staffUser) => {
          if (staffUser && staffUser.email) {
            sendEmail(
              staffUser.email,
              `🛠️ New Task Assigned: ${ticketNumber}`,
              getComplaintUpdateTemplate(
                staffUser.firstName,
                ticketNumber,
                data.title,
                'IN_PROGRESS',
                category,
                `You have been assigned to this ticket directly upon creation. Title: ${data.title}. Description: ${data.description}`
              )
            ).catch((err) => logger.error(`SMTP: Failed to notify staff user ${staffUser.email} of creation assignment:`, err));
          }
        }).catch((err) => logger.error('SMTP: Failed to query staff user for creation assignment alert:', err));
      }

      return ApiResponse.success(
        res,
        complaint,
        staff
          ? `Complaint raised and assigned to ${staff.firstName} ${staff.lastName} successfully.`
          : `Complaint raised successfully. AI-classified Category: ${category}`,
        201
      );
    } catch (error) {
      next(error);
    }
  }

  // Get active tickets list (Filterable by status)
  static async getComplaints(req: Request, res: Response, next: NextFunction) {
    try {
      const tenantId = req.tenantId!;
      const status = req.query.status as string;

      const complaints = await prisma.complaint.findMany({
        where: {
          tenantId,
          deletedAt: null,
          ...(status ? { status: status as any } : {}),
        },
        include: {
          resident: {
            select: { firstName: true, lastName: true, email: true, phoneNumber: true },
          },
          staff: true,
          comments: {
            include: {
              user: {
                select: { firstName: true, lastName: true, email: true },
              },
            },
            orderBy: { createdAt: 'asc' },
          },
        },
        orderBy: { createdAt: 'desc' },
      });

      return ApiResponse.success(res, complaints, 'Complaints loaded successfully');
    } catch (error) {
      next(error);
    }
  }

  // Assign staff to resolve ticket
  static async assignStaff(req: Request, res: Response, next: NextFunction) {
    try {
      const tenantId = req.tenantId!;
      const complaintId = req.params.complaintId;
      const { staffId } = assignSchema.parse(req.body);

      const staff = await prisma.staff.findUnique({
        where: { id: staffId, tenantId, deletedAt: null },
      });

      if (!staff) {
        return ApiResponse.error(res, 'Maintenance staff member not found.', null, 404);
      }

      const complaint = await prisma.complaint.update({
        where: { id: complaintId, tenantId },
        data: {
          assignedTo: staffId,
          status: 'IN_PROGRESS',
        },
      });

      // Asynchronously send SMTP notifications to Resident and Staff
      prisma.user.findUnique({
        where: { id: complaint.raisedBy },
      }).then((residentUser) => {
        if (residentUser && residentUser.email) {
          sendEmail(
            residentUser.email,
            `🛠️ Complaint Assigned: Technician is on the Way`,
            getComplaintUpdateTemplate(
              residentUser.firstName,
              complaint.ticketNumber,
              complaint.title,
              'IN_PROGRESS',
              complaint.category,
              `Technician assigned: ${staff.firstName} ${staff.lastName} (${staff.type}). Work is in progress.`
            )
          ).catch((err) => logger.error(`SMTP: Failed to notify resident ${residentUser.email} of technician assignment:`, err));
        }
      }).catch((err) => logger.error('SMTP: Failed to query resident for assignment alert:', err));

      if (staff.userId) {
        prisma.user.findUnique({
          where: { id: staff.userId },
        }).then((staffUser) => {
          if (staffUser && staffUser.email) {
            sendEmail(
              staffUser.email,
              `🛠️ New Task Assigned: ${complaint.ticketNumber}`,
              getComplaintUpdateTemplate(
                staffUser.firstName,
                complaint.ticketNumber,
                complaint.title,
                'IN_PROGRESS',
                complaint.category,
                `You have been assigned a new task: ${complaint.description}. Priority is set to ${complaint.priority}.`
              )
            ).catch((err) => logger.error(`SMTP: Failed to notify staff user ${staffUser.email} of task assignment:`, err));
          }
        }).catch((err) => logger.error('SMTP: Failed to query staff user for assignment task:', err));
      }

      return ApiResponse.success(res, complaint, `Ticket successfully assigned to ${staff.firstName} ${staff.lastName}`);
    } catch (error) {
      next(error);
    }
  }

  // Update complaint ticket status
  static async updateStatus(req: Request, res: Response, next: NextFunction) {
    try {
      const tenantId = req.tenantId!;
      const complaintId = req.params.complaintId;
      const status = req.body.status;

      if (!['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'].includes(status)) {
        return ApiResponse.error(res, 'Invalid status update command.', null, 400);
      }

      const complaint = await prisma.complaint.update({
        where: { id: complaintId, tenantId },
        data: { status },
      });

      // Asynchronously send status update email to Resident
      prisma.user.findUnique({
        where: { id: complaint.raisedBy },
      }).then((residentUser) => {
        if (residentUser && residentUser.email) {
          sendEmail(
            residentUser.email,
            `📝 Complaint Status Update: Ticket ${complaint.ticketNumber} is ${status}`,
            getComplaintUpdateTemplate(
              residentUser.firstName,
              complaint.ticketNumber,
              complaint.title,
              status,
              complaint.category,
              `Ticket status successfully updated to ${status}.`
            )
          ).catch((err) => logger.error(`SMTP: Failed to notify resident ${residentUser.email} of status update:`, err));
        }
      }).catch((err) => logger.error('SMTP: Failed to query resident for status alert:', err));

      return ApiResponse.success(res, complaint, `Complaint status updated to ${status}`);
    } catch (error) {
      next(error);
    }
  }

  // Add Comment thread details to Complaint
  static async addComment(req: Request, res: Response, next: NextFunction) {
    try {
      const tenantId = req.tenantId!;
      const complaintId = req.params.complaintId;
      const data = commentSchema.parse(req.body);
      const userId = req.user!.id;

      const comment = await prisma.complaintComment.create({
        data: {
          tenantId,
          complaintId,
          userId,
          comment: data.comment,
          attachments: data.attachments,
        },
        include: {
          user: {
            select: { firstName: true, lastName: true, email: true },
          },
        },
      });

      // Asynchronously fetch ticket relationships and trigger email alerts
      prisma.complaint.findUnique({
        where: { id: complaintId },
        include: {
          staff: {
            include: {
              user: true,
            },
          },
        },
      }).then((comp) => {
        if (!comp) return;
        const authorName = comment.user?.firstName || 'Staff member';
        const isResidentAuthor = userId === comp.raisedBy;
        const isStaffAuthor = comp.staff && userId === comp.staff.userId;

        // 1. Notify Resident (if author is NOT the resident)
        if (!isResidentAuthor) {
          prisma.user.findUnique({
            where: { id: comp.raisedBy },
          }).then((resUser) => {
            if (resUser && resUser.email) {
              sendEmail(
                resUser.email,
                `💬 New Comment on Ticket ${comp.ticketNumber}`,
                getComplaintUpdateTemplate(
                  resUser.firstName,
                  comp.ticketNumber,
                  comp.title,
                  comp.status,
                  comp.category,
                  `New update from ${authorName}: "${data.comment}"`
                )
              ).catch((err) => logger.error(`SMTP: Failed to notify resident ${resUser.email} of comment:`, err));
            }
          }).catch((err) => logger.error('SMTP: Failed to query resident for comment alert:', err));
        }

        // 2. Notify Assigned Staff (if author is NOT the staff member)
        const staffUserEmail = comp.staff?.user?.email;
        const staffUserFirstName = comp.staff?.user?.firstName;
        if (!isStaffAuthor && staffUserEmail && staffUserFirstName) {
          sendEmail(
            staffUserEmail,
            `💬 New Comment on Ticket ${comp.ticketNumber}`,
            getComplaintUpdateTemplate(
              staffUserFirstName,
              comp.ticketNumber,
              comp.title,
              comp.status,
              comp.category,
              `New resident update from ${authorName}: "${data.comment}"`
            )
          ).catch((err) => logger.error(`SMTP: Failed to notify staff ${staffUserEmail} of comment:`, err));
        }
      }).catch((err) => logger.error('SMTP: Failed to query complaint for comment alert:', err));

      return ApiResponse.success(res, comment, 'Comment added successfully', 201);
    } catch (error) {
      next(error);
    }
  }
}
export default ComplaintController;
