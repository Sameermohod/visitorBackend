import { Request, Response, NextFunction } from 'express';
import prisma from '../configs/db';
import ApiResponse from '../utils/apiResponse';

// Extend Express Request interface to include tenant details
declare global {
  namespace Express {
    interface Request {
      tenantId?: string;
      tenantSlug?: string;
    }
  }
}

export const tenantResolver = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  // Get current full path (before Express mounts strip prefix)
  const currentPath = req.originalUrl.split('?')[0];

  // If it's a public authentication, registration or Swagger documentation route, bypass tenant check
  const bypassPaths = [
    '/api/v1/auth/login',
    '/api/v1/auth/signup',
    '/api/v1/auth/refresh',
    '/api/v1/auth/super-login',
    '/api/v1/health',
    '/api-docs'
  ];

  if (bypassPaths.some((path) => currentPath.startsWith(path))) {
    return next();
  }

  const tenantId = req.headers['x-tenant-id'] as string;
  const tenantSlug = req.headers['x-tenant-slug'] as string;

  if (!tenantId && !tenantSlug) {
    return ApiResponse.error(res, 'Tenant context is missing. Please provide x-tenant-id or x-tenant-slug header.', null, 400);
  }

  try {
    let tenant;

    if (tenantId) {
      tenant = await prisma.tenant.findUnique({
        where: { id: tenantId, deletedAt: null },
      });
    } else if (tenantSlug) {
      tenant = await prisma.tenant.findUnique({
        where: { slug: tenantSlug, deletedAt: null },
      });
    }

    if (!tenant) {
      return ApiResponse.error(res, 'Tenant not found or has been deleted.', null, 404);
    }

    if (!tenant.isActive) {
      return ApiResponse.error(res, 'Tenant is suspended. Please contact Super Admin.', null, 403);
    }

    // Attach verified tenant constraints to request
    req.tenantId = tenant.id;
    req.tenantSlug = tenant.slug;

    next();
  } catch (error: any) {
    next(error);
  }
};

export default tenantResolver;
