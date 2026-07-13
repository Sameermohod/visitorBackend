"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.NoticeController = void 0;
const zod_1 = require("zod");
const db_1 = __importDefault(require("../../configs/db"));
const apiResponse_1 = __importDefault(require("../../utils/apiResponse"));
const emailService_1 = require("../../utils/emailService");
const noticeSchema = zod_1.z.object({
    title: zod_1.z.string().min(3),
    content: zod_1.z.string().min(10),
    category: zod_1.z.string().default('GENERAL'),
    visibility: zod_1.z.string().default('ALL'),
});
class NoticeController {
    static async createNotice(req, res, next) {
        try {
            const tenantId = req.tenantId;
            const data = noticeSchema.parse(req.body);
            const userId = req.user.id;
            const notice = await db_1.default.notice.create({
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
            const tenant = await db_1.default.tenant.findUnique({
                where: { id: tenantId }
            });
            // Fetch all onboarded residents to notify them
            const residents = await db_1.default.resident.findMany({
                where: { tenantId, deletedAt: null },
                include: { user: true }
            });
            // Send notice email notification to all residents
            residents.forEach((r) => {
                if (r.user?.email) {
                    (0, emailService_1.sendEmail)(r.user.email, `📢 New Notice: ${notice.title} - ${tenant?.name || 'Society Board'}`, (0, emailService_1.getNoticePublishedTemplate)(r.user.firstName, notice.title, notice.content, notice.category || 'GENERAL', tenant?.name || 'Society Board')).catch((err) => {
                        console.error(`Failed to send notice email to ${r.user.email}:`, err);
                    });
                }
            });
            return apiResponse_1.default.success(res, notice, 'Notice published successfully', 201);
        }
        catch (error) {
            next(error);
        }
    }
    static async getNotices(req, res, next) {
        try {
            const tenantId = req.tenantId;
            const notices = await db_1.default.notice.findMany({
                where: { tenantId, deletedAt: null },
                include: {
                    creator: {
                        select: { firstName: true, lastName: true },
                    },
                },
                orderBy: { publishAt: 'desc' },
            });
            return apiResponse_1.default.success(res, notices, 'Notices fetched successfully');
        }
        catch (error) {
            next(error);
        }
    }
}
exports.NoticeController = NoticeController;
exports.default = NoticeController;
