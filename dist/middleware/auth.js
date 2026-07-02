"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.checkRole = exports.checkPermission = exports.authenticate = void 0;
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const db_1 = __importDefault(require("../configs/db"));
const apiResponse_1 = __importDefault(require("../utils/apiResponse"));
const authenticate = async (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return apiResponse_1.default.error(res, 'Authentication token required.', null, 401);
    }
    const token = authHeader.split(' ')[1];
    try {
        const decoded = jsonwebtoken_1.default.verify(token, process.env.JWT_ACCESS_SECRET || 'super-secret-access-token-key-change-in-prod-1290312');
        // Fetch user and check active status
        const user = await db_1.default.user.findUnique({
            where: { id: decoded.userId, deletedAt: null },
            include: {
                role: {
                    include: {
                        permissions: {
                            include: {
                                permission: true,
                            },
                        },
                    },
                },
            },
        });
        if (!user) {
            return apiResponse_1.default.error(res, 'User session invalid or deleted.', null, 401);
        }
        // Tenant boundary check: make sure user belongs to the requested tenant
        if (req.tenantId && user.tenantId !== req.tenantId && user.role.name !== 'Super Admin') {
            return apiResponse_1.default.error(res, 'Access denied. You do not belong to this tenant.', null, 403);
        }
        req.user = {
            id: user.id,
            email: user.email,
            role: user.role.name,
            tenantId: user.tenantId,
            firstName: user.firstName,
            lastName: user.lastName,
        };
        // Flatten user permissions: e.g. ["visitor:create", "visitor:view"]
        req.permissions = user.role.permissions.map((rp) => rp.permission.code);
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
