import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import prisma from '../../configs/db';
import ApiResponse from '../../utils/apiResponse';
import { sendEmail, getNoticePublishedTemplate } from '../../utils/emailService';

const noticeSchema = z.object({
  title: z.string().min(3),
  content: z.string().min(10),
  category: z.string().default('GENERAL'),
  visibility: z.string().default('ALL'),
});

export class NoticeController {
  static async createNotice(req: Request, res: Response, next: NextFunction) {
    try {
      const tenantId = req.tenantId!;
      const data = noticeSchema.parse(req.body);
      const userId = req.user!.id;

      const notice = await prisma.notice.create({
        data: {
          tenantId,
          title: data.title,
          content: data.content,
          category: data.category,
          visibility: data.visibility,
          createdBy: userId,
        },
      });

      // Fetch tenant details
      const tenant = await prisma.tenant.findUnique({
        where: { id: tenantId }
      });

      // Fetch all onboarded residents to notify them
      const residents = await prisma.resident.findMany({
        where: { tenantId, deletedAt: null },
        include: { user: true }
      });

      // Send notice email notification to all residents
      residents.forEach((r) => {
        if (r.user?.email) {
          sendEmail(
            r.user.email,
            `📢 New Notice: ${notice.title} - ${tenant?.name || 'Society Board'}`,
            getNoticePublishedTemplate(
              r.user.firstName,
              notice.title,
              notice.content,
              notice.category || 'GENERAL',
              tenant?.name || 'Society Board'
            )
          ).catch((err) => {
            console.error(`Failed to send notice email to ${r.user.email}:`, err);
          });
        }
      });

      return ApiResponse.success(res, notice, 'Notice published successfully', 201);
    } catch (error) {
      next(error);
    }
  }

  static async getNotices(req: Request, res: Response, next: NextFunction) {
    try {
      const tenantId = req.tenantId!;

      const notices = await prisma.notice.findMany({
        where: { tenantId, deletedAt: null },
        include: {
          creator: {
            select: { firstName: true, lastName: true },
          },
        },
        orderBy: { publishAt: 'desc' },
      });

      return ApiResponse.success(res, notices, 'Notices fetched successfully');
    } catch (error) {
      next(error);
    }
  }
}
export default NoticeController;
