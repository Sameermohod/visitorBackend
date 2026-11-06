"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.allowTenantFeature = exports.invalidateTenantAccess = exports.normaliseAccess = exports.DEFAULT_ACCESS = void 0;
const db_1 = __importDefault(require("../configs/db"));
const cache_1 = require("../utils/cache");
const apiResponse_1 = __importDefault(require("../utils/apiResponse"));
exports.DEFAULT_ACCESS = { visitors: true, complaints: true };
// What each tenant is allowed to do, as set by their landlord. Read on many requests, so cached briefly.
const cache = new cache_1.TtlCache(30_000);
const normaliseAccess = (raw) => {
    const a = (raw && typeof raw === 'object' ? raw : {});
    return { visitors: a.visitors !== false, complaints: a.complaints !== false };
};
exports.normaliseAccess = normaliseAccess;
const invalidateTenantAccess = (renterUserId) => cache.invalidate(renterUserId);
exports.invalidateTenantAccess = invalidateTenantAccess;
const accessFor = async (tenantId, userId) => {
    const hit = cache.get(userId);
    if (hit)
        return hit;
    const tenancy = await db_1.default.tenancy.findFirst({
        where: { tenantId, renterUserId: userId, status: 'ACTIVE' },
        select: { access: true },
    });
    // A Tenant login with no active tenancy has nothing it may do
    const access = tenancy ? (0, exports.normaliseAccess)(tenancy.access) : { visitors: false, complaints: false };
    cache.set(userId, access);
    return access;
};
/**
 * Everyone except a Tenant passes. A Tenant passes only if their landlord left this feature on.
 * Sends the 403 itself and returns false when blocked.
 */
const allowTenantFeature = async (req, res, feature) => {
    if (req.user.role !== 'Tenant')
        return true;
    const access = await accessFor(req.tenantId, req.user.id);
    if (access[feature])
        return true;
    apiResponse_1.default.error(res, feature === 'visitors'
        ? 'Visitor passes have been switched off for your tenancy. Please ask the flat owner.'
        : 'Complaints have been switched off for your tenancy. Please ask the flat owner.', null, 403);
    return false;
};
exports.allowTenantFeature = allowTenantFeature;
