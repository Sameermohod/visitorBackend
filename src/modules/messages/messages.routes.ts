import { Router } from 'express';
import { authenticate } from '../../middleware/auth';
import { MessagesController } from './messages.controller';

// Messaging needs no extra permission: what each person may do is decided by their role (see messages.rules.ts)
const router = Router();
router.use(authenticate);

router.get('/conversations', MessagesController.list);
router.get('/unread', MessagesController.unread);
router.get('/people', MessagesController.people);
router.post('/direct', MessagesController.startDirect);
router.get('/conversations/:id/messages', MessagesController.history);
router.post('/conversations/:id/messages', MessagesController.send);
router.post('/conversations/:id/read', MessagesController.markRead);
router.delete('/:id', MessagesController.remove);

export default router;
