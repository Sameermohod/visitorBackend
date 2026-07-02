import { Router } from 'express';
import { ComplaintController } from './complaint.controller';
import { authenticate, checkPermission } from '../../middleware/auth';

const router = Router();

// Secure all pathways with authentication
router.use(authenticate);

/**
 * @swagger
 * /api/v1/complaints:
 *   get:
 *     summary: Fetch society complaint lists
 */
router.get(
  '/',
  checkPermission('complaints:view'),
  ComplaintController.getComplaints
);

/**
 * @swagger
 * /api/v1/complaints/raise:
 *   post:
 *     summary: Raise ticket under AI categorizer
 */
router.post(
  '/raise',
  checkPermission('complaints:create'),
  ComplaintController.raiseComplaint
);

/**
 * @swagger
 * /api/v1/complaints/:complaintId/assign:
 *   post:
 *     summary: Society admin assigns technician staff
 */
router.post(
  '/:complaintId/assign',
  checkPermission('complaints:resolve'),
  ComplaintController.assignStaff
);

/**
 * @swagger
 * /api/v1/complaints/:complaintId/status:
 *   patch:
 *     summary: Resolve or close tickets
 */
router.patch(
  '/:complaintId/status',
  checkPermission('complaints:resolve'),
  ComplaintController.updateStatus
);

/**
 * @swagger
 * /api/v1/complaints/:complaintId/comments:
 *   post:
 *     summary: Add note or update comment
 */
router.post(
  '/:complaintId/comments',
  checkPermission('complaints:view'),
  ComplaintController.addComment
);

export default router;
