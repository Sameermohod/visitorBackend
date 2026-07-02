import { Router } from 'express';
import { ChatController } from './chat.controller';
import { authenticate } from '../../middleware/auth';

const router = Router();

// Secure all chat routes under token authentication
router.use(authenticate);

/**
 * @swagger
 * /api/v1/chat:
 *   post:
 *     summary: Chat with tenant-isolated society AI assistant
 */
router.post('/', ChatController.chat);

export default router;
