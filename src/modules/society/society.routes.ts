import { Router } from 'express';
import { SocietyController } from './society.controller';
import { authenticate, checkPermission, checkAnyPermission } from '../../middleware/auth';

const router = Router();

// Secure all endpoints with authentication
router.use(authenticate);

/**
 * @swagger
 * /api/v1/society:
 *   get:
 *     summary: Get details of active society structure
 */
router.get('/', SocietyController.getSociety);

/**
 * @swagger
 * /api/v1/society/buildings:
 *   post:
 *     summary: Add building tower
 */
router.post(
  '/buildings',
  checkPermission('society:manage'),
  SocietyController.createBuilding
);

/**
 * @swagger
 * /api/v1/society/flats/batch:
 *   post:
 *     summary: Batch onboard wing structure and flats
 */
router.post(
  '/flats/batch',
  checkPermission('society:manage'),
  SocietyController.batchGenerateFlats
);

/**
 * @swagger
 * /api/v1/society/flats:
 *   get:
 *     summary: Get simple flat lists
 */
// Lists every resident of every flat, so only roles that run the society or the gate may call it
router.get('/flats', checkAnyPermission('residents:view', 'visitors:gate'), SocietyController.getFlats);

/**
 * @swagger
 * /api/v1/society/settings:
 *   get:
 *     summary: Fetch tenant custom settings
 */
router.get('/settings', SocietyController.getSettings);

/**
 * @swagger
 * /api/v1/society/settings:
 *   post:
 *     summary: Update tenant custom settings
 */
router.post(
  '/settings',
  checkPermission('tenant:settings'),
  SocietyController.updateSettings
);

export default router;
