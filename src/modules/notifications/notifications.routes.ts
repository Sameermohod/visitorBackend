import { Router, Request, Response, NextFunction } from 'express';
import prisma from '../../configs/db';
import ApiResponse from '../../utils/apiResponse';
import { authenticate } from '../../middleware/auth';

// The signed-in user's own in-app notifications (the bell in the app header)
const router = Router();
router.use(authenticate);

router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const where = { userId: req.user!.id };
    const [items, unread] = await Promise.all([
      prisma.notification.findMany({ where, orderBy: { createdAt: 'desc' }, take: 30 }),
      prisma.notification.count({ where: { ...where, isRead: false } }),
    ]);
    return ApiResponse.success(res, { items, unread }, 'Notifications loaded');
  } catch (error) {
    next(error);
  }
});

router.post('/read-all', async (req: Request, res: Response, next: NextFunction) => {
  try {
    await prisma.notification.updateMany({ where: { userId: req.user!.id, isRead: false }, data: { isRead: true } });
    return ApiResponse.success(res, null, 'All notifications marked as read');
  } catch (error) {
    next(error);
  }
});

export default router;
