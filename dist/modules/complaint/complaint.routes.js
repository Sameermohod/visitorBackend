"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const complaint_controller_1 = require("./complaint.controller");
const auth_1 = require("../../middleware/auth");
const router = (0, express_1.Router)();
// Secure all pathways with authentication
router.use(auth_1.authenticate);
/**
 * @swagger
 * /api/v1/complaints:
 *   get:
 *     summary: Fetch society complaint lists
 */
router.get('/', (0, auth_1.checkPermission)('complaints:view'), complaint_controller_1.ComplaintController.getComplaints);
/**
 * @swagger
 * /api/v1/complaints/raise:
 *   post:
 *     summary: Raise ticket under AI categorizer
 */
router.post('/raise', (0, auth_1.checkPermission)('complaints:create'), complaint_controller_1.ComplaintController.raiseComplaint);
/**
 * @swagger
 * /api/v1/complaints/:complaintId/assign:
 *   post:
 *     summary: Society admin assigns technician staff
 */
router.post('/:complaintId/assign', (0, auth_1.checkPermission)('complaints:resolve'), complaint_controller_1.ComplaintController.assignStaff);
/**
 * @swagger
 * /api/v1/complaints/:complaintId/status:
 *   patch:
 *     summary: Resolve or close tickets
 */
router.patch('/:complaintId/status', (0, auth_1.checkPermission)('complaints:resolve'), complaint_controller_1.ComplaintController.updateStatus);
/**
 * @swagger
 * /api/v1/complaints/:complaintId/comments:
 *   post:
 *     summary: Add note or update comment
 */
router.post('/:complaintId/comments', (0, auth_1.checkPermission)('complaints:view'), complaint_controller_1.ComplaintController.addComment);
exports.default = router;
