"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.samePath = exports.cameraIsLive = exports.hasGrant = exports.clearCameraDecisions = exports.verifyViewToken = exports.signViewToken = exports.VIEW_TOKEN_TTL_S = void 0;
const secrets_1 = require("../configs/secrets");
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const db_1 = __importDefault(require("../configs/db"));
const cache_1 = require("../utils/cache");
/** A viewing token lasts this long; the player asks for a fresh one before it runs out. */
exports.VIEW_TOKEN_TTL_S = 15 * 60;
const secret = () => (0, secrets_1.viewSecret)();
const signViewToken = (claims) => jsonwebtoken_1.default.sign({ typ: 'cam', ...claims }, secret(), { expiresIn: exports.VIEW_TOKEN_TTL_S });
exports.signViewToken = signViewToken;
const verifyViewToken = (token) => {
    try {
        const c = jsonwebtoken_1.default.verify(token, secret());
        return c.typ === 'cam' ? c : null;
    }
    catch {
        return null;
    }
};
exports.verifyViewToken = verifyViewToken;
// The gateway asks "may this person read this camera?" for every video chunk, so answers are cached briefly.
// Changing who has access clears the cache at once.
const decisions = new cache_1.TtlCache(20_000, 10_000);
const clearCameraDecisions = () => decisions.clear();
exports.clearCameraDecisions = clearCameraDecisions;
/** Does this person hold a current grant on this (live) camera? Managers are checked by the caller. */
const hasGrant = async (tenantId, userId, cameraId) => {
    const key = `${userId}:${cameraId}`;
    const hit = decisions.get(key);
    if (hit !== undefined)
        return hit;
    const grant = await db_1.default.cameraAccess.findFirst({
        where: {
            tenantId, userId, cameraId,
            OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
            camera: { isActive: true, deletedAt: null },
        },
        select: { id: true },
    });
    decisions.set(key, !!grant);
    return !!grant;
};
exports.hasGrant = hasGrant;
/** A camera still exists and is switched on (used for managers, who need no grant). */
const cameraIsLive = async (tenantId, cameraId) => {
    const key = `live:${cameraId}`;
    const hit = decisions.get(key);
    if (hit !== undefined)
        return hit;
    const cam = await db_1.default.camera.findFirst({ where: { id: cameraId, tenantId, isActive: true, deletedAt: null }, select: { id: true } });
    decisions.set(key, !!cam);
    return !!cam;
};
exports.cameraIsLive = cameraIsLive;
const normalise = (p) => p.replace(/^\/+|\/+$/g, '');
const samePath = (a, b) => normalise(a) === normalise(b);
exports.samePath = samePath;
