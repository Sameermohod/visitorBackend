import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import prisma from '../configs/db';
import ApiResponse from '../utils/apiResponse';

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
      };
      permissions?: string[];
    }
  }
}

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
      process.env.JWT_ACCESS_SECRET || 'super-secret-access-token-key-change-in-prod-1290312'
    ) as DecodedToken;

    // Fetch user and check active status
    const user = await prisma.user.findUnique({
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
      return ApiResponse.error(res, 'User session invalid or deleted.', null, 401);
    }

    // Tenant boundary check: make sure user belongs to the requested tenant
    if (req.tenantId && user.tenantId !== req.tenantId && user.role.name !== 'Super Admin') {
      return ApiResponse.error(res, 'Access denied. You do not belong to this tenant.', null, 403);
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
