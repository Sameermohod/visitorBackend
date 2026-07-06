"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const visitor_controller_1 = require("./visitor.controller");
const auth_1 = require("../../middleware/auth");
const router = (0, express_1.Router)();
// Secure all pathways with authentication
router.use(auth_1.authenticate);
/**
 * @swagger
 * /api/v1/visitors/pre-approve:
 *   post:
 *     summary: Resident pre-approves visitor
 */
router.post('/pre-approve', (0, auth_1.checkPermission)('visitors:create'), visitor_controller_1.VisitorController.preApprove);
/**
 * @swagger
 * /api/v1/visitors/my-approvals:
 *   get:
 *     summary: Fetch resident's own pre-approvals
 */
router.get('/my-approvals', (0, auth_1.checkPermission)('visitors:create'), visitor_controller_1.VisitorController.getMyPreApprovals);
/**
 * @swagger
 * /api/v1/visitors/verify-pass:
 *   get:
 *     summary: Guard scans and checks QR pass authenticity
 */
router.get('/verify-pass', (0, auth_1.checkPermission)('visitors:gate'), visitor_controller_1.VisitorController.verifyPass);
/**
 * @swagger
 * /api/v1/visitors/check-in:
 *   post:
 *     summary: Guard executes log entry via DB procedures
 */
router.post('/check-in', (0, auth_1.checkPermission)('visitors:gate'), visitor_controller_1.VisitorController.checkIn);
/**
 * @swagger
 * /api/v1/visitors/check-out/:logId:
 *   post:
 *     summary: Guard marks visitor exit time
 */
router.post('/check-out/:logId', (0, auth_1.checkPermission)('visitors:gate'), visitor_controller_1.VisitorController.checkOut);
/**
 * @swagger
 * /api/v1/visitors/logs:
 *   get:
 *     summary: Fetch society visitor entry/exit history
 */
router.get('/logs', (0, auth_1.checkPermission)('visitors:view'), visitor_controller_1.VisitorController.getLogs);
/**
 * @swagger
 * /api/v1/visitors/face-enroll:
 *   post:
 *     summary: Enrolls biometric data
 */
router.post('/face-enroll', (0, auth_1.checkPermission)('visitors:create'), visitor_controller_1.VisitorController.enrollFace);
router.delete('/:passId', (0, auth_1.checkPermission)('visitors:create'), visitor_controller_1.VisitorController.deletePass);
exports.default = router;
