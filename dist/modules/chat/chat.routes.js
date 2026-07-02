"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const chat_controller_1 = require("./chat.controller");
const auth_1 = require("../../middleware/auth");
const router = (0, express_1.Router)();
// Secure all chat routes under token authentication
router.use(auth_1.authenticate);
/**
 * @swagger
 * /api/v1/chat:
 *   post:
 *     summary: Chat with tenant-isolated society AI assistant
 */
router.post('/', chat_controller_1.ChatController.chat);
exports.default = router;
