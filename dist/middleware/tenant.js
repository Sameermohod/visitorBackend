"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.tenantResolver = exports.tenantCache = void 0;
const db_1 = __importDefault(require("../configs/db"));
const apiResponse_1 = __importDefault(require("../utils/apiResponse"));
const cache_1 = require("../utils/cache");
// Tenant lookups happen on every request; cache them briefly. Cleared on suspend/delete.
exports.tenantCache = new cache_1.TtlCache(30_000);
const tenantResolver = async (req, res, next) => {
    // Get current full path (before Express mounts strip prefix)
    const currentPath = req.originalUrl.split('?')[0];
    // If it's a public authentication, registration or Swagger documentation route, bypass tenant check
    const bypassPaths = [
        '/api/v1/auth/login',
        '/api/v1/auth/signup',
        '/api/v1/auth/refresh',
        '/api/v1/auth/super-login',
        // Account actions that only need the signed-in user, so they also work for the platform Super Admin (no society)
        '/api/v1/auth/mcp-token',
        '/api/v1/auth/change-password',
        '/api/v1/health',
        '/api/v1/super-admin',
        '/api-docs'
    ];
    if (bypassPaths.some((path) => currentPath.startsWith(path))) {
        return next();
    }
    const tenantId = req.headers['x-tenant-id'];
    const tenantSlug = req.headers['x-tenant-slug'];
    if (!tenantId && !tenantSlug) {
        return apiResponse_1.default.error(res, 'Tenant context is missing. Please provide x-tenant-id or x-tenant-slug header.', null, 400);
    }
    try {
        const cacheKey = tenantId ? `id:${tenantId}` : `slug:${tenantSlug}`;
        let tenant = exports.tenantCache.get(cacheKey);
        if (!tenant) {
            const select = { id: true, slug: true, isActive: true };
            if (tenantId) {
                tenant = await db_1.default.tenant.findUnique({
                    where: { id: tenantId, deletedAt: null },
                    select,
                });
            }
            else if (tenantSlug) {
                tenant = await db_1.default.tenant.findUnique({
                    where: { slug: tenantSlug, deletedAt: null },
                    select,
                });
            }
            if (tenant)
                exports.tenantCache.set(cacheKey, tenant);
        }
        if (!tenant) {
            return apiResponse_1.default.error(res, 'Tenant not found or has been deleted.', null, 404);
        }
        if (!tenant.isActive) {
            return apiResponse_1.default.error(res, 'Tenant is suspended. Please contact Super Admin.', null, 403);
        }
        // Attach verified tenant constraints to request
        req.tenantId = tenant.id;
        req.tenantSlug = tenant.slug;
        next();
    }
    catch (error) {
        next(error);
    }
};
exports.tenantResolver = tenantResolver;
exports.default = exports.tenantResolver;
