"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.noStore = exports.validTenantHeaders = exports.corsOptions = exports.warnCors = exports.originAllowed = exports.clearFailures = exports.recordFailure = exports.lockState = exports.apiLimiter = exports.authLimiter = exports.strongPassword = void 0;
const express_rate_limit_1 = __importDefault(require("express-rate-limit"));
const zod_1 = require("zod");
const logger_1 = __importDefault(require("../configs/logger"));
const isProd = process.env.NODE_ENV === 'production';
/* ---------------- Passwords ---------------- */
const COMMON = new Set(['password', 'password1', 'password123', '12345678', '123456789', 'qwerty123', 'welcome123', 'admin123', 'letmein123', 'iloveyou1', 'abc12345']);
/** At least 8 characters with a letter and a number, not a well-known password. Used wherever someone chooses a new password. */
exports.strongPassword = zod_1.z
    .string()
    .min(8, 'Password must be at least 8 characters.')
    .max(128, 'Password is too long.')
    .refine((p) => /[A-Za-z]/.test(p) && /\d/.test(p), 'Password must contain a letter and a number.')
    .refine((p) => !COMMON.has(p.toLowerCase()), 'That password is too common. Choose another.');
/* ---------------- Rate limits ---------------- */
const tooMany = (message) => ({ success: false, message });
/** Sign-in, sign-up and token refresh: a small number of tries per address. Successful sign-ins do not count. */
exports.authLimiter = (0, express_rate_limit_1.default)({
    windowMs: 15 * 60 * 1000,
    max: Number(process.env.AUTH_RATE_LIMIT ?? 20),
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    message: tooMany('Too many sign-in attempts. Please wait a few minutes and try again.'),
});
/** Everything else under /api: generous, but not unlimited. */
exports.apiLimiter = (0, express_rate_limit_1.default)({
    windowMs: 15 * 60 * 1000,
    max: Number(process.env.API_RATE_LIMIT ?? 1000),
    standardHeaders: true,
    legacyHeaders: false,
    message: tooMany('Too many requests from this address. Please try again later.'),
});
/* ---------------- Account lock-out ---------------- */
// Counts wrong passwords per account (not per address), so guessing from many addresses is slowed too.
// Kept in memory: with several server copies, put this in Redis.
const MAX_FAILS = 6;
const LOCK_MS = 15 * 60 * 1000;
const fails = new Map();
const lockState = (key) => {
    const f = fails.get(key);
    if (!f)
        return { locked: false, retryInMs: 0 };
    if (f.lockedUntil > Date.now())
        return { locked: true, retryInMs: f.lockedUntil - Date.now() };
    if (Date.now() - f.first > LOCK_MS)
        fails.delete(key);
    return { locked: false, retryInMs: 0 };
};
exports.lockState = lockState;
const recordFailure = (key) => {
    const now = Date.now();
    const f = fails.get(key);
    if (!f || now - f.first > LOCK_MS) {
        fails.set(key, { n: 1, first: now, lockedUntil: 0 });
        return;
    }
    f.n += 1;
    if (f.n >= MAX_FAILS)
        f.lockedUntil = now + LOCK_MS;
};
exports.recordFailure = recordFailure;
const clearFailures = (key) => { fails.delete(key); };
exports.clearFailures = clearFailures;
setInterval(() => { const now = Date.now(); for (const [k, f] of fails)
    if (f.lockedUntil < now && now - f.first > LOCK_MS)
        fails.delete(k); }, 10 * 60 * 1000).unref();
/* ---------------- CORS ---------------- */
const clean = (v) => (v ?? '').split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);
const allowed = new Set([...clean(process.env.CORS_ORIGIN), ...clean(process.env.FRONTEND_URL)]);
const LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
/** Is this website allowed to call the API from a browser? (Native apps and servers send no Origin and are not affected.) */
const originAllowed = (origin) => {
    if (!origin)
        return true;
    const o = origin.replace(/\/+$/, '');
    if (allowed.has(o))
        return true;
    if (!isProd && LOCAL.test(o))
        return true;
    // Nothing configured in production: do not lock everyone out, but say so loudly (see warnCors)
    return isProd && allowed.size === 0;
};
exports.originAllowed = originAllowed;
const warnCors = () => {
    if (isProd && allowed.size === 0)
        logger_1.default.warn('CORS_ORIGIN / FRONTEND_URL are not set: any website can call this API from a browser. Set CORS_ORIGIN to your web app address.');
};
exports.warnCors = warnCors;
exports.corsOptions = {
    origin: (origin, cb) => cb(null, (0, exports.originAllowed)(origin)),
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-tenant-id', 'x-tenant-slug'],
    maxAge: 600,
};
/* ---------------- Request hygiene ---------------- */
/** The society id/slug come from headers: reject anything that is not shaped like one before it reaches the database. */
const validTenantHeaders = (req, res, next) => {
    const id = req.headers['x-tenant-id'];
    const slug = req.headers['x-tenant-slug'];
    if (id !== undefined && !(typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id)))
        return res.status(400).json({ success: false, message: 'Invalid society id.' });
    if (slug !== undefined && !(typeof slug === 'string' && /^[a-z0-9-]{1,64}$/i.test(slug)))
        return res.status(400).json({ success: false, message: 'Invalid society name.' });
    next();
};
exports.validTenantHeaders = validTenantHeaders;
/** Responses carry personal data: tell browsers and proxies not to keep copies. */
const noStore = (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    next();
};
exports.noStore = noStore;
