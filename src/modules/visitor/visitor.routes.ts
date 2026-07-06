import { Router } from 'express';
import { VisitorController } from './visitor.controller';
import { authenticate, checkPermission } from '../../middleware/auth';

const router = Router();

// Secure all pathways with authentication
router.use(authenticate);

/**
 * @swagger
 * /api/v1/visitors/pre-approve:
 *   post:
 *     summary: Resident pre-approves visitor
 */
router.post(
  '/pre-approve',
  checkPermission('visitors:create'),
  VisitorController.preApprove
);

/**
 * @swagger
 * /api/v1/visitors/my-approvals:
 *   get:
 *     summary: Fetch resident's own pre-approvals
 */
router.get(
  '/my-approvals',
  checkPermission('visitors:create'),
  VisitorController.getMyPreApprovals
);

/**
 * @swagger
 * /api/v1/visitors/verify-pass:
 *   get:
 *     summary: Guard scans and checks QR pass authenticity
 */
router.get(
  '/verify-pass',
  checkPermission('visitors:gate'),
  VisitorController.verifyPass
);

/**
 * @swagger
 * /api/v1/visitors/check-in:
 *   post:
 *     summary: Guard executes log entry via DB procedures
 */
router.post(
  '/check-in',
  checkPermission('visitors:gate'),
  VisitorController.checkIn
);

/**
 * @swagger
 * /api/v1/visitors/check-out/:logId:
 *   post:
 *     summary: Guard marks visitor exit time
 */
router.post(
  '/check-out/:logId',
  checkPermission('visitors:gate'),
  VisitorController.checkOut
);

/**
 * @swagger
 * /api/v1/visitors/logs:
 *   get:
 *     summary: Fetch society visitor entry/exit history
 */
router.get(
  '/logs',
  checkPermission('visitors:view'),
  VisitorController.getLogs
);

/**
 * @swagger
 * /api/v1/visitors/face-enroll:
 *   post:
 *     summary: Enrolls biometric data
 */
router.post(
  '/face-enroll',
  checkPermission('visitors:create'),
  VisitorController.enrollFace
);

router.delete(
  '/:passId',
  checkPermission('visitors:create'),
  VisitorController.deletePass
);

export default router;
