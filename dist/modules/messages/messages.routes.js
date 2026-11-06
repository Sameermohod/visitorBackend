"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const auth_1 = require("../../middleware/auth");
const messages_controller_1 = require("./messages.controller");
// Messaging needs no extra permission: what each person may do is decided by their role (see messages.rules.ts)
const router = (0, express_1.Router)();
router.use(auth_1.authenticate);
router.get('/conversations', messages_controller_1.MessagesController.list);
router.get('/unread', messages_controller_1.MessagesController.unread);
router.get('/people', messages_controller_1.MessagesController.people);
router.post('/direct', messages_controller_1.MessagesController.startDirect);
router.get('/conversations/:id/messages', messages_controller_1.MessagesController.history);
router.post('/conversations/:id/messages', messages_controller_1.MessagesController.send);
router.post('/conversations/:id/read', messages_controller_1.MessagesController.markRead);
router.delete('/:id', messages_controller_1.MessagesController.remove);
exports.default = router;
