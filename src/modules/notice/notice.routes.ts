import { Router } from 'express';
import { NoticeController } from './notice.controller';
import { authenticate } from '../../middleware/auth';

const router = Router();

// Secure all pathways with authentication
router.use(authenticate);

/**
 * @swagger
 * /api/v1/notices:
 *   get:
 *     summary: Fetch active society notices
 */
router.get('/', NoticeController.getNotices);

/**
 * @swagger
 * /api/v1/notices:
 *   post:
 *     summary: Create and publish notice announcement
 */
router.post('/', NoticeController.createNotice);

export default router;
