"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const analytics_controller_1 = require("./analytics.controller");
const auth_1 = require("../../middleware/auth");
const router = (0, express_1.Router)();
// Secure all pathways with authentication
router.use(auth_1.authenticate);
/**
 * @swagger
 * /api/v1/analytics/dashboard:
 *   get:
 *     summary: Fetch role-based consolidated dashboard metrics
 */
router.get('/dashboard', analytics_controller_1.AnalyticsController.getDashboardStats);
exports.default = router;
