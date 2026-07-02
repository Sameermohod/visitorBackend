"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const notice_controller_1 = require("./notice.controller");
const auth_1 = require("../../middleware/auth");
const router = (0, express_1.Router)();
// Secure all pathways with authentication
router.use(auth_1.authenticate);
/**
 * @swagger
 * /api/v1/notices:
 *   get:
 *     summary: Fetch active society notices
 */
router.get('/', notice_controller_1.NoticeController.getNotices);
/**
 * @swagger
 * /api/v1/notices:
 *   post:
 *     summary: Create and publish notice announcement
 */
router.post('/', notice_controller_1.NoticeController.createNotice);
exports.default = router;
