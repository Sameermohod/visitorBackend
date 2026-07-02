"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const auth_routes_1 = __importDefault(require("../modules/auth/auth.routes"));
const society_routes_1 = __importDefault(require("../modules/society/society.routes"));
const resident_routes_1 = __importDefault(require("../modules/resident/resident.routes"));
const visitor_routes_1 = __importDefault(require("../modules/visitor/visitor.routes"));
const complaint_routes_1 = __importDefault(require("../modules/complaint/complaint.routes"));
const billing_routes_1 = __importDefault(require("../modules/billing/billing.routes"));
const notice_routes_1 = __importDefault(require("../modules/notice/notice.routes"));
const analytics_routes_1 = __importDefault(require("../modules/analytics/analytics.routes"));
const staff_routes_1 = __importDefault(require("../modules/staff/staff.routes"));
const chat_routes_1 = __importDefault(require("../modules/chat/chat.routes"));
const apiResponse_1 = __importDefault(require("../utils/apiResponse"));
const router = (0, express_1.Router)();
// Version 1 Health Check
router.get('/health', (req, res) => {
    return apiResponse_1.default.success(res, { uptime: process.uptime() }, 'V1 API Server is operational');
});
// Bind modules
router.use('/auth', auth_routes_1.default);
router.use('/society', society_routes_1.default);
router.use('/residents', resident_routes_1.default);
router.use('/visitors', visitor_routes_1.default);
router.use('/complaints', complaint_routes_1.default);
router.use('/billing', billing_routes_1.default);
router.use('/notices', notice_routes_1.default);
router.use('/analytics', analytics_routes_1.default);
router.use('/staff', staff_routes_1.default);
router.use('/chat', chat_routes_1.default);
exports.default = router;
