import { Router } from 'express';
import { ResidentController } from './resident.controller';
import { authenticate, checkPermission } from '../../middleware/auth';

const router = Router();

// Secure all pathways with authentication
router.use(authenticate);

/**
 * @swagger
 * /api/v1/residents/directory:
 *   get:
 *     summary: Fetch society-wide resident directories
 */
router.get(
  '/directory',
  checkPermission('residents:view'),
  ResidentController.getDirectory
);

/**
 * @swagger
 * /api/v1/residents/onboard:
 *   post:
 *     summary: Onboard and register new resident
 */
router.post(
  '/onboard',
  checkPermission('residents:manage'),
  ResidentController.onboard
);

export default router;
