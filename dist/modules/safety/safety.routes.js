"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const crypto_1 = require("crypto");
const zod_1 = require("zod");
const db_1 = __importDefault(require("../../configs/db"));
const apiResponse_1 = __importDefault(require("../../utils/apiResponse"));
const logger_1 = __importDefault(require("../../configs/logger"));
const auth_1 = require("../../middleware/auth");
const hub_1 = require("../../realtime/hub");
const payments_1 = require("../../services/payments");
/**
 * Emergency SOS. The alert reaches every Security Guard, the Society Admin and the Society Secretary at once, with a
 * loud alert on their screen, and the sender sees the moment someone says they are on the way.
 */
const router = (0, express_1.Router)();
router.use(auth_1.authenticate);
const RESPONDERS = ['Security Guard', 'Society Admin', 'Society Secretary'];
const alerts = new Map();
const lastSos = new Map();
const forgetOld = () => {
    const cutoff = Date.now() - 60 * 60_000;
    alerts.forEach((a, id) => { if (a.at < cutoff)
        alerts.delete(id); });
};
router.post('/sos', (0, auth_1.checkPermission)('safety:sos'), async (req, res, next) => {
    try {
        const tenantId = req.tenantId;
        const me = req.user;
        if (!tenantId || me.role === 'Super Admin')
            return apiResponse_1.default.error(res, 'SOS is available inside a society.', null, 403);
        const { note } = zod_1.z.object({ note: zod_1.z.string().trim().max(200).optional() }).parse(req.body ?? {});
        // Stops an accidental double tap (or a prank) from flooding the guards
        const last = lastSos.get(me.id) ?? 0;
        if (Date.now() - last < 30_000)
            return apiResponse_1.default.error(res, 'Your alert was just sent. Help is being alerted.', null, 429);
        lastSos.set(me.id, Date.now());
        forgetOld();
        const [responders, resident] = await Promise.all([
            db_1.default.user.findMany({ where: { tenantId, deletedAt: null, id: { not: me.id }, role: { name: { in: RESPONDERS } } }, select: { id: true } }),
            db_1.default.resident.findFirst({ where: { tenantId, userId: me.id, deletedAt: null }, select: { flat: { select: { number: true } } } }),
        ]);
        const flat = resident?.flat?.number ?? null;
        const from = `${me.firstName} ${me.lastName}`.trim();
        const alertId = (0, crypto_1.randomUUID)();
        alerts.set(alertId, { tenantId, senderId: me.id, at: Date.now(), respondedBy: null });
        const ids = responders.map((r) => r.id);
        (0, hub_1.emitToUsers)(ids, 'sos', { alertId, from, role: me.role, flat, note: note || null, at: new Date().toISOString() });
        await (0, payments_1.notifyUsers)(tenantId, ids, `🚨 SOS from ${from}${flat ? ` (flat ${flat})` : ''}`, note || 'Needs help right now.', 'SOS');
        logger_1.default.warn(`SOS: ${from} (${me.role}${flat ? `, flat ${flat}` : ''}) raised an SOS; ${ids.length} responder(s) alerted.`);
        return apiResponse_1.default.success(res, { alertId, alerted: ids.length }, ids.length ? 'Help has been alerted.' : 'No guard or office account could be alerted. Please call for help.', 201);
    }
    catch (error) {
        next(error);
    }
});
router.post('/sos/:alertId/respond', async (req, res, next) => {
    try {
        const me = req.user;
        if (!RESPONDERS.includes(me.role))
            return apiResponse_1.default.error(res, 'Only guards and the society office can respond to an SOS.', null, 403);
        const alert = alerts.get(req.params.alertId);
        if (!alert || alert.tenantId !== req.tenantId)
            return apiResponse_1.default.error(res, 'This alert has ended.', null, 404);
        const name = `${me.firstName} ${me.lastName}`.trim();
        if (!alert.respondedBy)
            alert.respondedBy = name;
        (0, hub_1.emitToUsers)([alert.senderId], 'sos:response', { alertId: req.params.alertId, by: name, role: me.role });
        const others = await db_1.default.user.findMany({ where: { tenantId: alert.tenantId, deletedAt: null, id: { not: me.id }, role: { name: { in: RESPONDERS } } }, select: { id: true } });
        (0, hub_1.emitToUsers)(others.map((o) => o.id), 'sos:handled', { alertId: req.params.alertId, by: name });
        return apiResponse_1.default.success(res, null, 'The person has been told you are on the way.');
    }
    catch (error) {
        next(error);
    }
});
exports.default = router;
