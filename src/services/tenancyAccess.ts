import { Request, Response } from 'express';
import prisma from '../configs/db';
import { TtlCache } from '../utils/cache';
import ApiResponse from '../utils/apiResponse';

export type TenantFeature = 'visitors' | 'complaints';
export interface TenantAccess { visitors: boolean; complaints: boolean }

export const DEFAULT_ACCESS: TenantAccess = { visitors: true, complaints: true };

// What each tenant is allowed to do, as set by their landlord. Read on many requests, so cached briefly.
const cache = new TtlCache<TenantAccess>(30_000);

export const normaliseAccess = (raw: unknown): TenantAccess => {
  const a = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return { visitors: a.visitors !== false, complaints: a.complaints !== false };
};

export const invalidateTenantAccess = (renterUserId: string) => cache.invalidate(renterUserId);

const accessFor = async (tenantId: string, userId: string): Promise<TenantAccess> => {
  const hit = cache.get(userId);
  if (hit) return hit;
  const tenancy = await prisma.tenancy.findFirst({
    where: { tenantId, renterUserId: userId, status: 'ACTIVE' },
    select: { access: true },
  });
  // A Tenant login with no active tenancy has nothing it may do
  const access = tenancy ? normaliseAccess(tenancy.access) : { visitors: false, complaints: false };
  cache.set(userId, access);
  return access;
};

/**
 * Everyone except a Tenant passes. A Tenant passes only if their landlord left this feature on.
 * Sends the 403 itself and returns false when blocked.
 */
export const allowTenantFeature = async (req: Request, res: Response, feature: TenantFeature): Promise<boolean> => {
  if (req.user!.role !== 'Tenant') return true;
  const access = await accessFor(req.tenantId!, req.user!.id);
  if (access[feature]) return true;
  ApiResponse.error(
    res,
    feature === 'visitors'
      ? 'Visitor passes have been switched off for your tenancy. Please ask the flat owner.'
      : 'Complaints have been switched off for your tenancy. Please ask the flat owner.',
    null,
    403
  );
  return false;
};
