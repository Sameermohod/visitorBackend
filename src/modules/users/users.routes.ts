import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import prisma from '../../configs/db';
import ApiResponse from '../../utils/apiResponse';
import logger from '../../configs/logger';
import { authenticate, checkPermission, userCache } from '../../middleware/auth';

const router = Router();
router.use(authenticate);

/**
 * Hide (or show again) the AI chatbot for one person in this society.
 * Also blocks that person from connecting an AI app (MCP), since that is the same assistant access.
 * Needs chat:manage (Society Admin and Society Secretary).
 */
router.patch('/:userId/chat-access', checkPermission('chat:manage'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { disabled } = z.object({ disabled: z.boolean() }).parse(req.body);

    const target = await prisma.user.findFirst({
      where: { id: req.params.userId, tenantId: req.tenantId!, deletedAt: null },
      select: { id: true, firstName: true, lastName: true, role: { select: { name: true } } },
    });
    if (!target || target.role.name === 'Super Admin') {
      return ApiResponse.error(res, 'Person not found in this society.', null, 404);
    }

    await prisma.user.update({ where: { id: target.id }, data: { aiChatDisabled: disabled, updatedBy: req.user!.id } });
    userCache.invalidate(target.id); // takes effect immediately, not after the cache expires

    logger.info(`Users: ${req.user!.email} ${disabled ? 'hid' : 'restored'} the AI chatbot for ${target.firstName} ${target.lastName}.`);
    return ApiResponse.success(
      res,
      { userId: target.id, aiChatDisabled: disabled },
      disabled ? `Chatbot hidden for ${target.firstName}.` : `Chatbot is available to ${target.firstName} again.`
    );
  } catch (error) {
    next(error);
  }
});

/**
 * Stop (or allow again) a person from sending messages in this society's chat.
 * Needs chat:manage (Society Admin and Society Secretary). The office itself cannot be switched off.
 */
router.patch('/:userId/messaging-access', checkPermission('chat:manage'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { disabled } = z.object({ disabled: z.boolean() }).parse(req.body);

    const target = await prisma.user.findFirst({
      where: { id: req.params.userId, tenantId: req.tenantId!, deletedAt: null },
      select: { id: true, firstName: true, lastName: true, role: { select: { name: true } } },
    });
    if (!target || target.role.name === 'Super Admin') {
      return ApiResponse.error(res, 'Person not found in this society.', null, 404);
    }
    if (['Society Admin', 'Society Secretary'].includes(target.role.name)) {
      return ApiResponse.error(res, 'The society office cannot be blocked from messaging.', null, 400);
    }

    await prisma.user.update({ where: { id: target.id }, data: { messagingDisabled: disabled, updatedBy: req.user!.id } });
    userCache.invalidate(target.id);

    logger.info(`Users: ${req.user!.email} ${disabled ? 'blocked' : 'allowed'} messaging for ${target.firstName} ${target.lastName}.`);
    return ApiResponse.success(
      res,
      { userId: target.id, messagingDisabled: disabled },
      disabled ? `${target.firstName} can no longer send messages.` : `${target.firstName} can send messages again.`
    );
  } catch (error) {
    next(error);
  }
});

export default router;
