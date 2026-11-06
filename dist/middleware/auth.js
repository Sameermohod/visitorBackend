"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.checkRole = exports.checkAnyPermission = exports.checkPermission = exports.authenticate = exports.userCache = void 0;
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const db_1 = __importDefault(require("../configs/db"));
const apiResponse_1 = __importDefault(require("../utils/apiResponse"));
const cache_1 = require("../utils/cache");
const secrets_1 = require("../configs/secrets");
// Auth runs on every request; cache the user + permission lookup briefly. Invalidated on user deletion.
exports.userCache = new cache_1.TtlCache(30_000);
const authenticate = async (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return apiResponse_1.default.error(res, 'Authentication token required.', null, 401);
    }
    const token = authHeader.split(' ')[1];
    try {
        const decoded = jsonwebtoken_1.default.verify(token, (0, secrets_1.accessSecret)());
        // Only real login tokens open the API. A long-lived connection token (MCP) works on /mcp alone, so a leaked one cannot drive the rest of the app.
        if (typeof decoded.userId !== 'string' || decoded.typ) {
            return apiResponse_1.default.error(res, 'Invalid token credentials.', null, 401);
        }
        if (decoded.type === 'mcp' && !req.originalUrl.startsWith('/mcp')) {
            return apiResponse_1.default.error(res, 'This token can only be used to connect an AI app.', null, 401);
        }
        // Fetch user (with role + permissions) and check active status; cached briefly per user
        let user = exports.userCache.get(decoded.userId);
        if (!user) {
            const found = await db_1.default.user.findUnique({ relationLoadStrategy: 'join',
                where: { id: decoded.userId, deletedAt: null },
                select: {
                    id: true,
                    email: true,
                    firstName: true,
                    lastName: true,
                    tenantId: true,
                    aiChatDisabled: true,
                    messagingDisabled: true,
                    role: {
                        select: {
                            name: true,
                            permissions: { select: { permission: { select: { code: true } } } },
                        },
                    },
                },
            });
            if (found) {
                user = {
                    id: found.id,
                    email: found.email,
                    firstName: found.firstName,
                    lastName: found.lastName,
                    tenantId: found.tenantId,
                    aiChatDisabled: found.aiChatDisabled,
                    messagingDisabled: found.messagingDisabled,
                    roleName: found.role.name,
                    permissions: found.role.permissions.map((rp) => rp.permission.code),
                };
                exports.userCache.set(decoded.userId, user);
            }
        }
        if (!user) {
            return apiResponse_1.default.error(res, 'User session invalid or deleted.', null, 401);
        }
        // Tenant boundary check: make sure user belongs to the requested tenant
        if (req.tenantId && user.tenantId !== req.tenantId && user.roleName !== 'Super Admin') {
            return apiResponse_1.default.error(res, 'Access denied. You do not belong to this tenant.', null, 403);
        }
        req.user = {
            id: user.id,
            email: user.email,
            role: user.roleName,
            tenantId: user.tenantId,
            firstName: user.firstName,
            lastName: user.lastName,
            aiChatDisabled: user.aiChatDisabled,
            messagingDisabled: user.messagingDisabled,
        };
        // Flattened user permissions: e.g. ["visitor:create", "visitor:view"]
        req.permissions = user.permissions;
        next();
    }
    catch (error) {
        if (error.name === 'TokenExpiredError') {
            return apiResponse_1.default.error(res, 'Token has expired. Please refresh.', null, 401);
        }
        return apiResponse_1.default.error(res, 'Invalid token credentials.', null, 401);
    }
};
exports.authenticate = authenticate;
// RBAC: Check for specific permission node
const checkPermission = (permissionCode) => {
    return (req, res, next) => {
        if (!req.user || !req.permissions) {
            return apiResponse_1.default.error(res, 'Unauthenticated session.', null, 401);
        }
        // Super Admin bypasses all specific permissions
        if (req.user.role === 'Super Admin') {
            return next();
        }
        if (!req.permissions.includes(permissionCode)) {
            return apiResponse_1.default.error(res, `Forbidden: Insufficient permissions (${permissionCode}).`, null, 403);
        }
        next();
    };
};
exports.checkPermission = checkPermission;
// RBAC: allow if the user holds ANY of the listed permissions
const checkAnyPermission = (...permissionCodes) => {
    return (req, res, next) => {
        if (!req.user || !req.permissions) {
            return apiResponse_1.default.error(res, 'Unauthenticated session.', null, 401);
        }
        if (req.user.role === 'Super Admin' || permissionCodes.some((code) => req.permissions.includes(code))) {
            return next();
        }
        return apiResponse_1.default.error(res, `Forbidden: Insufficient permissions (${permissionCodes.join(' or ')}).`, null, 403);
    };
};
exports.checkAnyPermission = checkAnyPermission;
// Role check helper for major structural switches
const checkRole = (allowedRoles) => {
    return (req, res, next) => {
        if (!req.user) {
            return apiResponse_1.default.error(res, 'Unauthenticated session.', null, 401);
        }
        if (!allowedRoles.includes(req.user.role)) {
            return apiResponse_1.default.error(res, 'Forbidden: Role restricted access.', null, 403);
        }
        next();
    };
};
exports.checkRole = checkRole;
