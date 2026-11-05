import { Router, Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import prisma from '../../configs/db';
import ApiResponse from '../../utils/apiResponse';
import logger from '../../configs/logger';
import { authenticate, checkPermission } from '../../middleware/auth';
import { emitToUsers } from '../../realtime/hub';
import { notifyUsers } from '../../services/payments';

/**
 * Emergency SOS. The alert reaches every Security Guard, the Society Admin and the Society Secretary at once, with a
 * loud alert on their screen, and the sender sees the moment someone says they are on the way.
 */
const router = Router();
router.use(authenticate);

const RESPONDERS = ['Security Guard', 'Society Admin', 'Society Secretary'];

// Open alerts are remembered for an hour so a responder's "I'm on my way" can reach the sender
interface Alert { tenantId: string; senderId: string; at: number; respondedBy: string | null }
const alerts = new Map<string, Alert>();
const lastSos = new Map<string, number>();
const forgetOld = () => {
  const cutoff = Date.now() - 60 * 60_000;
  alerts.forEach((a, id) => { if (a.at < cutoff) alerts.delete(id); });
};

router.post('/sos', checkPermission('safety:sos'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tenantId = req.tenantId;
    const me = req.user!;
    if (!tenantId || me.role === 'Super Admin') return ApiResponse.error(res, 'SOS is available inside a society.', null, 403);

    const { note } = z.object({ note: z.string().trim().max(200).optional() }).parse(req.body ?? {});

    // Stops an accidental double tap (or a prank) from flooding the guards
    const last = lastSos.get(me.id) ?? 0;
    if (Date.now() - last < 30_000) return ApiResponse.error(res, 'Your alert was just sent. Help is being alerted.', null, 429);
    lastSos.set(me.id, Date.now());
    forgetOld();

    const [responders, resident] = await Promise.all([
      prisma.user.findMany({ where: { tenantId, deletedAt: null, id: { not: me.id }, role: { name: { in: RESPONDERS } } }, select: { id: true } }),
      prisma.resident.findFirst({ where: { tenantId, userId: me.id, deletedAt: null }, select: { flat: { select: { number: true } } } }),
    ]);

    const flat = resident?.flat?.number ?? null;
    const from = `${me.firstName} ${me.lastName}`.trim();
    const alertId = randomUUID();
    alerts.set(alertId, { tenantId, senderId: me.id, at: Date.now(), respondedBy: null });

    const ids = responders.map((r) => r.id);
    emitToUsers(ids, 'sos', { alertId, from, role: me.role, flat, note: note || null, at: new Date().toISOString() });
    await notifyUsers(tenantId, ids, `🚨 SOS from ${from}${flat ? ` (flat ${flat})` : ''}`, note || 'Needs help right now.', 'SOS');
    logger.warn(`SOS: ${from} (${me.role}${flat ? `, flat ${flat}` : ''}) raised an SOS; ${ids.length} responder(s) alerted.`);

    return ApiResponse.success(res, { alertId, alerted: ids.length }, ids.length ? 'Help has been alerted.' : 'No guard or office account could be alerted. Please call for help.', 201);
  } catch (error) {
    next(error);
  }
});

router.post('/sos/:alertId/respond', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const me = req.user!;
    if (!RESPONDERS.includes(me.role)) return ApiResponse.error(res, 'Only guards and the society office can respond to an SOS.', null, 403);

    const alert = alerts.get(req.params.alertId);
    if (!alert || alert.tenantId !== req.tenantId) return ApiResponse.error(res, 'This alert has ended.', null, 404);

    const name = `${me.firstName} ${me.lastName}`.trim();
    if (!alert.respondedBy) alert.respondedBy = name;
    emitToUsers([alert.senderId], 'sos:response', { alertId: req.params.alertId, by: name, role: me.role });

    const others = await prisma.user.findMany({ where: { tenantId: alert.tenantId, deletedAt: null, id: { not: me.id }, role: { name: { in: RESPONDERS } } }, select: { id: true } });
    emitToUsers(others.map((o) => o.id), 'sos:handled', { alertId: req.params.alertId, by: name });
    return ApiResponse.success(res, null, 'The person has been told you are on the way.');
  } catch (error) {
    next(error);
  }
});

export default router;
