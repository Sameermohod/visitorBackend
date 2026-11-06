"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const zod_1 = require("zod");
const db_1 = __importDefault(require("../../configs/db"));
const apiResponse_1 = __importDefault(require("../../utils/apiResponse"));
const logger_1 = __importDefault(require("../../configs/logger"));
const auth_1 = require("../../middleware/auth");
const router = (0, express_1.Router)();
router.use(auth_1.authenticate);
/**
 * Hide (or show again) the AI chatbot for one person in this society.
 * Also blocks that person from connecting an AI app (MCP), since that is the same assistant access.
 * Needs chat:manage (Society Admin and Society Secretary).
 */
router.patch('/:userId/chat-access', (0, auth_1.checkPermission)('chat:manage'), async (req, res, next) => {
    try {
        const { disabled } = zod_1.z.object({ disabled: zod_1.z.boolean() }).parse(req.body);
        const target = await db_1.default.user.findFirst({
            where: { id: req.params.userId, tenantId: req.tenantId, deletedAt: null },
            select: { id: true, firstName: true, lastName: true, role: { select: { name: true } } },
        });
        if (!target || target.role.name === 'Super Admin') {
            return apiResponse_1.default.error(res, 'Person not found in this society.', null, 404);
        }
        await db_1.default.user.update({ where: { id: target.id }, data: { aiChatDisabled: disabled, updatedBy: req.user.id } });
        auth_1.userCache.invalidate(target.id); // takes effect immediately, not after the cache expires
        logger_1.default.info(`Users: ${req.user.email} ${disabled ? 'hid' : 'restored'} the AI chatbot for ${target.firstName} ${target.lastName}.`);
        return apiResponse_1.default.success(res, { userId: target.id, aiChatDisabled: disabled }, disabled ? `Chatbot hidden for ${target.firstName}.` : `Chatbot is available to ${target.firstName} again.`);
    }
    catch (error) {
        next(error);
    }
});
/**
 * Stop (or allow again) a person from sending messages in this society's chat.
 * Needs chat:manage (Society Admin and Society Secretary). The office itself cannot be switched off.
 */
router.patch('/:userId/messaging-access', (0, auth_1.checkPermission)('chat:manage'), async (req, res, next) => {
    try {
        const { disabled } = zod_1.z.object({ disabled: zod_1.z.boolean() }).parse(req.body);
        const target = await db_1.default.user.findFirst({
            where: { id: req.params.userId, tenantId: req.tenantId, deletedAt: null },
            select: { id: true, firstName: true, lastName: true, role: { select: { name: true } } },
        });
        if (!target || target.role.name === 'Super Admin') {
            return apiResponse_1.default.error(res, 'Person not found in this society.', null, 404);
        }
        if (['Society Admin', 'Society Secretary'].includes(target.role.name)) {
            return apiResponse_1.default.error(res, 'The society office cannot be blocked from messaging.', null, 400);
        }
        await db_1.default.user.update({ where: { id: target.id }, data: { messagingDisabled: disabled, updatedBy: req.user.id } });
        auth_1.userCache.invalidate(target.id);
        logger_1.default.info(`Users: ${req.user.email} ${disabled ? 'blocked' : 'allowed'} messaging for ${target.firstName} ${target.lastName}.`);
        return apiResponse_1.default.success(res, { userId: target.id, messagingDisabled: disabled }, disabled ? `${target.firstName} can no longer send messages.` : `${target.firstName} can send messages again.`);
    }
    catch (error) {
        next(error);
    }
});
exports.default = router;
