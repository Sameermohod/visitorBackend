"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.gatewayAuth = exports.CamerasController = void 0;
const zod_1 = require("zod");
const db_1 = __importDefault(require("../../configs/db"));
const apiResponse_1 = __importDefault(require("../../utils/apiResponse"));
const logger_1 = __importDefault(require("../../configs/logger"));
const crypto_1 = require("../../utils/crypto");
const payments_1 = require("../../services/payments");
const cameraAccess_1 = require("../../services/cameraAccess");
const KINDS = ['GATE', 'COMMON', 'PARKING', 'OTHER'];
const pathRule = zod_1.z.string().trim().regex(/^[A-Za-z0-9_\-]+(\/[A-Za-z0-9_\-]+)*$/, 'Use letters, numbers, dashes and underscores (for example main-gate).').max(100);
const httpsUrl = zod_1.z.string().trim().url().max(2000).refine((u) => /^https?:\/\//i.test(u), 'The link must start with http:// or https://');
const rtspUrl = zod_1.z.string().trim().max(2000).refine((u) => {
    try {
        return ['rtsp:', 'rtsps:'].includes(new URL(u).protocol) && !!new URL(u).hostname;
    }
    catch {
        return false;
    }
}, 'The link must start with rtsp:// (for example rtsp://user:password@192.168.1.20:554/stream).');
// A short, safe stream name for the gateway, made from the camera name
const slug = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'camera';
// MediaMTX config values go in single quotes
const yq = (v) => `'${v.replace(/'/g, "''")}'`;
const createSchema = zod_1.z.object({
    name: zod_1.z.string().trim().min(2).max(100),
    location: zod_1.z.string().trim().max(150).optional().or(zod_1.z.literal('')),
    kind: zod_1.z.enum(KINDS).default('COMMON'),
    source: zod_1.z.enum(['GATEWAY', 'HLS_URL', 'RTSP']),
    gatewayPath: pathRule.optional(),
    streamUrl: httpsUrl.optional(),
    rtspUrl: rtspUrl.optional(),
});
const updateSchema = zod_1.z.object({
    name: zod_1.z.string().trim().min(2).max(100).optional(),
    location: zod_1.z.string().trim().max(150).nullable().optional(),
    kind: zod_1.z.enum(KINDS).optional(),
    isActive: zod_1.z.boolean().optional(),
    gatewayPath: pathRule.optional(),
    streamUrl: httpsUrl.optional(),
    rtspUrl: rtspUrl.optional(),
});
const grantSchema = zod_1.z.object({
    userIds: zod_1.z.array(zod_1.z.string().uuid()).min(1).max(100),
    days: zod_1.z.number().int().min(1).max(365).nullable().optional(), // null / missing = until removed
});
const isManager = (req) => req.user.role === 'Super Admin' || !!req.permissions?.includes('cameras:manage');
const apiPublicUrl = (req) => (process.env.API_PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
// What the list shows: never the stream link or any secret
const publicCamera = (c) => ({
    id: c.id, name: c.name, location: c.location, kind: c.kind, source: c.source, isActive: c.isActive,
});
class CamerasController {
    // Managers see every camera; everyone else only the cameras they have been given access to
    static async list(req, res, next) {
        try {
            const tenantId = req.tenantId;
            if (isManager(req)) {
                const cameras = await db_1.default.camera.findMany({
                    where: { tenantId, deletedAt: null },
                    include: { _count: { select: { access: true } } },
                    orderBy: { createdAt: 'asc' },
                });
                return apiResponse_1.default.success(res, cameras.map((c) => ({ ...publicCamera(c), gatewayPath: c.gatewayPath, hasStreamUrl: !!c.streamUrlEnc, accessCount: c._count.access })), 'Cameras loaded');
            }
            const grants = await db_1.default.cameraAccess.findMany({
                where: {
                    tenantId, userId: req.user.id,
                    OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
                    camera: { isActive: true, deletedAt: null },
                },
                select: { expiresAt: true, camera: { select: { id: true, name: true, location: true, kind: true, source: true, isActive: true } } },
            });
            return apiResponse_1.default.success(res, grants.map((g) => ({ ...publicCamera(g.camera), accessUntil: g.expiresAt })), 'Cameras loaded');
        }
        catch (error) {
            next(error);
        }
    }
    // Society-level setup: where the gateway is, and the address it must call to check viewers
    static async getSettings(req, res, next) {
        try {
            const tenant = await db_1.default.tenant.findUnique({ where: { id: req.tenantId }, select: { cameraGatewayUrl: true } });
            return apiResponse_1.default.success(res, { gatewayUrl: tenant?.cameraGatewayUrl ?? null, authUrl: `${apiPublicUrl(req)}/api/v1/cameras/gateway-auth` }, 'Camera settings loaded');
        }
        catch (error) {
            next(error);
        }
    }
    static async saveSettings(req, res, next) {
        try {
            const { gatewayUrl } = zod_1.z.object({ gatewayUrl: httpsUrl.or(zod_1.z.literal('')).nullable() }).parse(req.body);
            const clean = gatewayUrl ? gatewayUrl.replace(/\/+$/, '') : null;
            await db_1.default.tenant.update({ where: { id: req.tenantId }, data: { cameraGatewayUrl: clean } });
            return apiResponse_1.default.success(res, { gatewayUrl: clean }, clean ? 'Camera gateway saved.' : 'Camera gateway removed.');
        }
        catch (error) {
            next(error);
        }
    }
    // The gateway settings file for every camera added by RTSP link. Contains the cameras' passwords, so managers only.
    static async gatewayConfig(req, res, next) {
        try {
            const tenantId = req.tenantId;
            const origin = typeof req.query.origin === 'string' && /^https?:\/\/[^\s']+$/i.test(req.query.origin) ? req.query.origin.replace(/\/+$/, '') : null;
            const cams = await db_1.default.camera.findMany({
                where: { tenantId, deletedAt: null, source: 'RTSP', gatewayPath: { not: null }, streamUrlEnc: { not: null } },
                select: { id: true, name: true, gatewayPath: true, streamUrlEnc: true },
                orderBy: { createdAt: 'asc' },
            });
            const paths = cams.map((c) => ({ id: c.id, name: c.name, path: c.gatewayPath, rtsp: (0, crypto_1.decrypt)(c.streamUrlEnc) }));
            const yaml = [
                'authMethod: http',
                `authHTTPAddress: ${apiPublicUrl(req)}/api/v1/cameras/gateway-auth`,
                'authHTTPExclude:',
                '  - action: api',
                '  - action: metrics',
                '  - action: pprof',
                `hlsAllowOrigins: [${yq(origin ?? '*')}]`,
                'paths:',
                ...(paths.length ? paths.flatMap((p) => [`  ${p.path}:`, `    source: ${yq(p.rtsp)}`, '    sourceOnDemand: yes']) : ['  # No cameras added by RTSP link yet']),
            ].join('\n') + '\n';
            return apiResponse_1.default.success(res, { yaml, count: paths.length, cameras: paths.map(({ id, name, path }) => ({ id, name, path })) }, 'Gateway settings ready');
        }
        catch (error) {
            next(error);
        }
    }
    static async create(req, res, next) {
        try {
            const tenantId = req.tenantId;
            const data = createSchema.parse(req.body);
            if (data.source === 'GATEWAY' && !data.gatewayPath)
                return apiResponse_1.default.error(res, 'Enter the stream name set up on your gateway.', null, 400);
            if (data.source === 'HLS_URL' && !data.streamUrl)
                return apiResponse_1.default.error(res, 'Paste the HLS link for this camera.', null, 400);
            if (data.source === 'RTSP' && !data.rtspUrl)
                return apiResponse_1.default.error(res, 'Paste the RTSP link for this camera.', null, 400);
            if (data.source === 'GATEWAY') {
                const clash = await db_1.default.camera.findFirst({ where: { tenantId, gatewayPath: data.gatewayPath, deletedAt: null }, select: { name: true } });
                if (clash)
                    return apiResponse_1.default.error(res, `The stream name "${data.gatewayPath}" is already used by ${clash.name}.`, null, 409);
            }
            // An RTSP camera gets its own stream name on the gateway, so the person adding it never has to invent one
            let gatewayPath = data.source === 'GATEWAY' ? data.gatewayPath : null;
            if (data.source === 'RTSP') {
                const base = slug(data.name);
                const taken = new Set((await db_1.default.camera.findMany({ where: { tenantId, deletedAt: null, gatewayPath: { startsWith: base } }, select: { gatewayPath: true } })).map((c) => c.gatewayPath));
                gatewayPath = base;
                for (let i = 2; taken.has(gatewayPath); i++)
                    gatewayPath = `${base}-${i}`;
            }
            const camera = await db_1.default.camera.create({
                data: {
                    tenantId, name: data.name, location: data.location || null, kind: data.kind, source: data.source,
                    gatewayPath,
                    streamUrlEnc: data.source === 'HLS_URL' ? (0, crypto_1.encrypt)(data.streamUrl) : data.source === 'RTSP' ? (0, crypto_1.encrypt)(data.rtspUrl) : null,
                    createdBy: req.user.id,
                },
            });
            logger_1.default.info(`Cameras: ${req.user.email} added camera "${camera.name}".`);
            return apiResponse_1.default.success(res, publicCamera(camera), `${camera.name} added. Now choose who can watch it.`, 201);
        }
        catch (error) {
            next(error);
        }
    }
    static async update(req, res, next) {
        try {
            const tenantId = req.tenantId;
            const data = updateSchema.parse(req.body);
            const cam = await db_1.default.camera.findFirst({ where: { id: req.params.id, tenantId, deletedAt: null } });
            if (!cam)
                return apiResponse_1.default.error(res, 'Camera not found.', null, 404);
            if (data.gatewayPath && data.gatewayPath !== cam.gatewayPath) {
                const clash = await db_1.default.camera.findFirst({ where: { tenantId, gatewayPath: data.gatewayPath, deletedAt: null, NOT: { id: cam.id } }, select: { name: true } });
                if (clash)
                    return apiResponse_1.default.error(res, `The stream name "${data.gatewayPath}" is already used by ${clash.name}.`, null, 409);
            }
            const updated = await db_1.default.camera.update({
                where: { id: cam.id },
                data: {
                    ...(data.name !== undefined ? { name: data.name } : {}),
                    ...(data.location !== undefined ? { location: data.location || null } : {}),
                    ...(data.kind !== undefined ? { kind: data.kind } : {}),
                    ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
                    ...(data.gatewayPath && cam.source === 'GATEWAY' ? { gatewayPath: data.gatewayPath } : {}),
                    ...(data.streamUrl && cam.source === 'HLS_URL' ? { streamUrlEnc: (0, crypto_1.encrypt)(data.streamUrl) } : {}),
                    ...(data.rtspUrl && cam.source === 'RTSP' ? { streamUrlEnc: (0, crypto_1.encrypt)(data.rtspUrl) } : {}),
                    updatedAt: new Date(),
                },
            });
            (0, cameraAccess_1.clearCameraDecisions)(); // switching a camera off takes effect straight away
            return apiResponse_1.default.success(res, publicCamera(updated), 'Camera updated.');
        }
        catch (error) {
            next(error);
        }
    }
    static async remove(req, res, next) {
        try {
            const cam = await db_1.default.camera.findFirst({ where: { id: req.params.id, tenantId: req.tenantId, deletedAt: null } });
            if (!cam)
                return apiResponse_1.default.error(res, 'Camera not found.', null, 404);
            await db_1.default.camera.update({ where: { id: cam.id }, data: { deletedAt: new Date(), isActive: false } });
            (0, cameraAccess_1.clearCameraDecisions)();
            return apiResponse_1.default.success(res, null, `${cam.name} removed.`);
        }
        catch (error) {
            next(error);
        }
    }
    /* ---------------- Who can watch ---------------- */
    static async listAccess(req, res, next) {
        try {
            const tenantId = req.tenantId;
            const cam = await db_1.default.camera.findFirst({ where: { id: req.params.id, tenantId, deletedAt: null }, select: { id: true } });
            if (!cam)
                return apiResponse_1.default.error(res, 'Camera not found.', null, 404);
            const rows = await db_1.default.cameraAccess.findMany({
                relationLoadStrategy: 'join',
                where: { cameraId: cam.id, tenantId },
                select: { id: true, expiresAt: true, createdAt: true, user: { select: { id: true, firstName: true, lastName: true, role: { select: { name: true } } } } },
                orderBy: { createdAt: 'desc' },
            });
            const flats = await db_1.default.resident.findMany({
                where: { tenantId, userId: { in: rows.map((r) => r.user.id) }, deletedAt: null },
                select: { userId: true, flat: { select: { number: true } } },
            });
            return apiResponse_1.default.success(res, rows.map((r) => ({ ...r, flatNumber: flats.find((f) => f.userId === r.user.id)?.flat?.number ?? null, expired: !!r.expiresAt && r.expiresAt < new Date() })), 'Access list loaded');
        }
        catch (error) {
            next(error);
        }
    }
    static async grant(req, res, next) {
        try {
            const tenantId = req.tenantId;
            const { userIds, days } = grantSchema.parse(req.body);
            const cam = await db_1.default.camera.findFirst({ where: { id: req.params.id, tenantId, deletedAt: null }, select: { id: true, name: true } });
            if (!cam)
                return apiResponse_1.default.error(res, 'Camera not found.', null, 404);
            // Only people who belong to this society (never the platform Super Admin)
            const people = await db_1.default.user.findMany({
                where: { id: { in: userIds }, tenantId, deletedAt: null, NOT: { role: { name: 'Super Admin' } } },
                select: { id: true },
            });
            if (!people.length)
                return apiResponse_1.default.error(res, 'Those people were not found in this society.', null, 404);
            const expiresAt = days ? new Date(Date.now() + days * 86400000) : null;
            await db_1.default.$transaction(people.map((p) => db_1.default.cameraAccess.upsert({
                where: { cameraId_userId: { cameraId: cam.id, userId: p.id } },
                create: { tenantId, cameraId: cam.id, userId: p.id, grantedBy: req.user.id, expiresAt },
                update: { grantedBy: req.user.id, expiresAt },
            })));
            (0, cameraAccess_1.clearCameraDecisions)();
            await (0, payments_1.notifyUsers)(tenantId, people.map((p) => p.id), 'You can now watch a camera', `${cam.name}${days ? ` (for ${days} day${days === 1 ? '' : 's'})` : ''}. Open Cameras to watch it live.`, 'CAMERA');
            logger_1.default.info(`Cameras: ${req.user.email} gave ${people.length} person(s) access to "${cam.name}".`);
            return apiResponse_1.default.success(res, { granted: people.length }, `${people.length} ${people.length === 1 ? 'person can' : 'people can'} now watch ${cam.name}.`, 201);
        }
        catch (error) {
            next(error);
        }
    }
    static async revoke(req, res, next) {
        try {
            const removed = await db_1.default.cameraAccess.deleteMany({ where: { cameraId: req.params.id, userId: req.params.userId, tenantId: req.tenantId } });
            if (!removed.count)
                return apiResponse_1.default.error(res, 'That person did not have access.', null, 404);
            (0, cameraAccess_1.clearCameraDecisions)(); // their video stops within seconds, not when the token runs out
            return apiResponse_1.default.success(res, null, 'Access removed.');
        }
        catch (error) {
            next(error);
        }
    }
    static async logs(req, res, next) {
        try {
            const tenantId = req.tenantId;
            const rows = await db_1.default.cameraViewLog.findMany({
                relationLoadStrategy: 'join',
                where: { cameraId: req.params.id, tenantId },
                select: { id: true, createdAt: true, ipAddress: true, user: { select: { firstName: true, lastName: true, role: { select: { name: true } } } } },
                orderBy: { createdAt: 'desc' },
                take: 100,
            });
            return apiResponse_1.default.success(res, rows, 'Viewing log loaded');
        }
        catch (error) {
            next(error);
        }
    }
    /* ---------------- Watching ---------------- */
    // Returns what the player needs. Logged once per viewing; the player renews the token quietly with ?renew=1.
    static async view(req, res, next) {
        try {
            const tenantId = req.tenantId;
            const user = req.user;
            const manager = isManager(req);
            const cam = await db_1.default.camera.findFirst({ where: { id: req.params.id, tenantId, deletedAt: null, isActive: true } });
            if (!cam)
                return apiResponse_1.default.error(res, 'This camera is not available.', null, 404);
            if (!manager && !(await (0, cameraAccess_1.hasGrant)(tenantId, user.id, cam.id))) {
                return apiResponse_1.default.error(res, 'You have not been given access to this camera. Ask the Secretary.', null, 403);
            }
            if (req.query.renew !== '1') {
                await db_1.default.cameraViewLog.create({ data: { tenantId, cameraId: cam.id, userId: user.id, ipAddress: req.ip ?? null } });
            }
            if (cam.source === 'HLS_URL') {
                // A ready-made link: only people with access ever receive it
                return apiResponse_1.default.success(res, { source: 'HLS_URL', url: (0, crypto_1.decrypt)(cam.streamUrlEnc), token: null, expiresAt: null }, 'Ready');
            }
            const tenant = await db_1.default.tenant.findUnique({ where: { id: tenantId }, select: { cameraGatewayUrl: true } });
            if (!tenant?.cameraGatewayUrl)
                return apiResponse_1.default.error(res, 'The camera gateway has not been set up yet. Ask the Secretary.', null, 409);
            const token = (0, cameraAccess_1.signViewToken)({ sub: user.id, tid: tenantId, cam: cam.id, path: cam.gatewayPath, mgr: manager });
            return apiResponse_1.default.success(res, { source: 'GATEWAY', url: `${tenant.cameraGatewayUrl}/${cam.gatewayPath}/index.m3u8`, token, expiresAt: new Date(Date.now() + cameraAccess_1.VIEW_TOKEN_TTL_S * 1000).toISOString() }, 'Ready');
        }
        catch (error) {
            next(error);
        }
    }
}
exports.CamerasController = CamerasController;
/**
 * Called by the society's MediaMTX gateway before it serves any video (it POSTs JSON; a 2xx answer allows it).
 * Not behind the normal login: the viewer's short-lived token is the credential, and it is checked here.
 * The answer also tells MediaMTX when to end the session, so a viewing never outlives its token.
 */
const gatewayAuth = async (req, res) => {
    const b = (req.body ?? {});
    const deny = () => res.status(401).json({ allowed: false });
    // Browsers only ever watch (HLS / WebRTC). Publishing, playback and admin calls are never allowed through this door.
    if (b.action !== 'read' || (b.protocol !== 'hls' && b.protocol !== 'webrtc'))
        return deny();
    const candidate = [b.token, b.password].find((v) => typeof v === 'string' && v.split('.').length === 3);
    const claims = candidate ? (0, cameraAccess_1.verifyViewToken)(candidate) : null;
    if (!claims || typeof b.path !== 'string' || !(0, cameraAccess_1.samePath)(b.path, claims.path))
        return deny();
    const ok = claims.mgr ? await (0, cameraAccess_1.cameraIsLive)(claims.tid, claims.cam) : await (0, cameraAccess_1.hasGrant)(claims.tid, claims.sub, claims.cam);
    if (!ok)
        return deny();
    return res.status(200).json({ expireAt: new Date(claims.exp * 1000).toISOString() });
};
exports.gatewayAuth = gatewayAuth;
exports.default = CamerasController;
