import { Router } from 'express';
import { AnalyticsController } from './analytics.controller';
import { authenticate } from '../../middleware/auth';

const router = Router();

// Secure all pathways with authentication
router.use(authenticate);

/**
 * @swagger
 * /api/v1/analytics/dashboard:
 *   get:
 *     summary: Fetch role-based consolidated dashboard metrics
 */
router.get('/dashboard', AnalyticsController.getDashboardStats);

export default router;
