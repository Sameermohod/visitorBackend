"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const db_1 = __importDefault(require("../../configs/db"));
const apiResponse_1 = __importDefault(require("../../utils/apiResponse"));
const auth_1 = require("../../middleware/auth");
// The signed-in user's own in-app notifications (the bell in the app header)
const router = (0, express_1.Router)();
router.use(auth_1.authenticate);
router.get('/', async (req, res, next) => {
    try {
        const where = { userId: req.user.id };
        const [items, unread] = await Promise.all([
            db_1.default.notification.findMany({ where, orderBy: { createdAt: 'desc' }, take: 30 }),
            db_1.default.notification.count({ where: { ...where, isRead: false } }),
        ]);
        return apiResponse_1.default.success(res, { items, unread }, 'Notifications loaded');
    }
    catch (error) {
        next(error);
    }
});
router.post('/read-all', async (req, res, next) => {
    try {
        await db_1.default.notification.updateMany({ where: { userId: req.user.id, isRead: false }, data: { isRead: true } });
        return apiResponse_1.default.success(res, null, 'All notifications marked as read');
    }
    catch (error) {
        next(error);
    }
});
exports.default = router;
