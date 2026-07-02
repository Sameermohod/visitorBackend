"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const staff_controller_1 = require("./staff.controller");
const auth_1 = require("../../middleware/auth");
const router = (0, express_1.Router)();
// Secure all pathways with authentication
router.use(auth_1.authenticate);
/**
 * @swagger
 * /api/v1/staff/directory:
 *   get:
 *     summary: Fetch society-wide staff and guard registries
 */
router.get('/directory', (req, res, next) => {
    if (!req.user || !req.permissions) {
        return res.status(401).json({ success: false, message: 'Unauthenticated session.' });
    }
    if (req.user.role === 'Super Admin' || req.permissions.includes('staff:manage') || req.permissions.includes('complaints:create')) {
        return next();
    }
    return res.status(403).json({ success: false, message: 'Forbidden: Insufficient permissions (staff:manage or complaints:create required).' });
}, staff_controller_1.StaffController.getDirectory);
/**
 * @swagger
 * /api/v1/staff/onboard:
 *   post:
 *     summary: Onboard and register new staff member or guard
 */
router.post('/onboard', (0, auth_1.checkPermission)('staff:manage'), staff_controller_1.StaffController.onboard);
exports.default = router;
