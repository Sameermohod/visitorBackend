import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import prisma from '../configs/db';
import ApiResponse from '../utils/apiResponse';
import { TtlCache } from '../utils/cache';
import { accessSecret } from '../configs/secrets';

declare global {
  namespace Express {
    interface Request {
      user?: {
        id: string;
        email: string;
        role: string;
        tenantId: string | null;
        firstName: string;
        lastName: string;
        aiChatDisabled: boolean;
        messagingDisabled: boolean;
      };
      permissions?: string[];
    }
  }
}

interface CachedUser {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  tenantId: string | null;
  aiChatDisabled: boolean;
  messagingDisabled: boolean;
  roleName: string;
  permissions: string[];
}

// Auth runs on every request; cache the user + permission lookup briefly. Invalidated on user deletion.
export const userCache = new TtlCache<CachedUser>(30_000);

interface DecodedToken {
  userId: string;
  email: string;
  role: string;
  tenantId: string | null;
}

export const authenticate = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return ApiResponse.error(res, 'Authentication token required.', null, 401);
  }

  const token = authHeader.split(' ')[1];

  try {
    const decoded = jwt.verify(
      token,
      accessSecret()
    ) as DecodedToken & { type?: string; typ?: string };

    // Only real login tokens open the API. A long-lived connection token (MCP) works on /mcp alone, so a leaked one cannot drive the rest of the app.
    if (typeof decoded.userId !== 'string' || decoded.typ) {
      return ApiResponse.error(res, 'Invalid token credentials.', null, 401);
    }
    if (decoded.type === 'mcp' && !req.originalUrl.startsWith('/mcp')) {
      return ApiResponse.error(res, 'This token can only be used to connect an AI app.', null, 401);
    }

    // Fetch user (with role + permissions) and check active status; cached briefly per user
    let user = userCache.get(decoded.userId);
    if (!user) {
      const found = await prisma.user.findUnique({ relationLoadStrategy: 'join',
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
        userCache.set(decoded.userId, user);
      }
    }

    if (!user) {
      return ApiResponse.error(res, 'User session invalid or deleted.', null, 401);
    }

    // Tenant boundary check: make sure user belongs to the requested tenant
    if (req.tenantId && user.tenantId !== req.tenantId && user.roleName !== 'Super Admin') {
      return ApiResponse.error(res, 'Access denied. You do not belong to this tenant.', null, 403);
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
  } catch (error: any) {
    if (error.name === 'TokenExpiredError') {
      return ApiResponse.error(res, 'Token has expired. Please refresh.', null, 401);
    }
    return ApiResponse.error(res, 'Invalid token credentials.', null, 401);
  }
};

// RBAC: Check for specific permission node
export const checkPermission = (permissionCode: string) => {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user || !req.permissions) {
      return ApiResponse.error(res, 'Unauthenticated session.', null, 401);
    }

    // Super Admin bypasses all specific permissions
    if (req.user.role === 'Super Admin') {
      return next();
    }

    if (!req.permissions.includes(permissionCode)) {
      return ApiResponse.error(res, `Forbidden: Insufficient permissions (${permissionCode}).`, null, 403);
    }

    next();
  };
};

// RBAC: allow if the user holds ANY of the listed permissions
export const checkAnyPermission = (...permissionCodes: string[]) => {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user || !req.permissions) {
      return ApiResponse.error(res, 'Unauthenticated session.', null, 401);
    }
    if (req.user.role === 'Super Admin' || permissionCodes.some((code) => req.permissions!.includes(code))) {
      return next();
    }
    return ApiResponse.error(res, `Forbidden: Insufficient permissions (${permissionCodes.join(' or ')}).`, null, 403);
  };
};

// Role check helper for major structural switches
export const checkRole = (allowedRoles: string[]) => {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      return ApiResponse.error(res, 'Unauthenticated session.', null, 401);
    }

    if (!allowedRoles.includes(req.user.role)) {
      return ApiResponse.error(res, 'Forbidden: Role restricted access.', null, 403);
    }

    next();
  };
};
