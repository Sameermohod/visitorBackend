import { Router } from 'express';
import { StaffController } from './staff.controller';
import { authenticate, checkPermission } from '../../middleware/auth';

const router = Router();

// Secure all pathways with authentication
router.use(authenticate);

/**
 * @swagger
 * /api/v1/staff/directory:
 *   get:
 *     summary: Fetch society-wide staff and guard registries
 */
router.get(
  '/directory',
  (req, res, next) => {
    if (!req.user || !req.permissions) {
      return res.status(401).json({ success: false, message: 'Unauthenticated session.' });
    }
    if (req.user.role === 'Super Admin' || req.permissions.includes('staff:manage') || req.permissions.includes('complaints:create')) {
      return next();
    }
    return res.status(403).json({ success: false, message: 'Forbidden: Insufficient permissions (staff:manage or complaints:create required).' });
  },
  StaffController.getDirectory
);

/**
 * @swagger
 * /api/v1/staff/onboard:
 *   post:
 *     summary: Onboard and register new staff member or guard
 */
router.post(
  '/onboard',
  checkPermission('staff:manage'),
  StaffController.onboard
);

router.patch(
  '/:staffId/status',
  checkPermission('staff:manage'),
  StaffController.toggleActive
);

export default router;
