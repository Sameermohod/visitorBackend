import { viewSecret } from '../configs/secrets';
import jwt from 'jsonwebtoken';
import prisma from '../configs/db';
import { TtlCache } from '../utils/cache';

/** A viewing token lasts this long; the player asks for a fresh one before it runs out. */
export const VIEW_TOKEN_TTL_S = 15 * 60;

const secret = () => viewSecret();

export interface ViewClaims {
  typ: 'cam';
  sub: string; // user id
  tid: string; // society id
  cam: string; // camera id
  path: string; // the stream path on the gateway this token is good for
  mgr: boolean; // Admin/Secretary: may watch every camera
}

export const signViewToken = (claims: Omit<ViewClaims, 'typ'>) =>
  jwt.sign({ typ: 'cam', ...claims }, secret(), { expiresIn: VIEW_TOKEN_TTL_S });

export const verifyViewToken = (token: string): (ViewClaims & { exp: number }) | null => {
  try {
    const c = jwt.verify(token, secret()) as ViewClaims & { exp: number };
    return c.typ === 'cam' ? c : null;
  } catch {
    return null;
  }
};

// The gateway asks "may this person read this camera?" for every video chunk, so answers are cached briefly.
// Changing who has access clears the cache at once.
const decisions = new TtlCache<boolean>(20_000, 10_000);
export const clearCameraDecisions = () => decisions.clear();

/** Does this person hold a current grant on this (live) camera? Managers are checked by the caller. */
export const hasGrant = async (tenantId: string, userId: string, cameraId: string): Promise<boolean> => {
  const key = `${userId}:${cameraId}`;
  const hit = decisions.get(key);
  if (hit !== undefined) return hit;
  const grant = await prisma.cameraAccess.findFirst({
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

/** A camera still exists and is switched on (used for managers, who need no grant). */
export const cameraIsLive = async (tenantId: string, cameraId: string): Promise<boolean> => {
  const key = `live:${cameraId}`;
  const hit = decisions.get(key);
  if (hit !== undefined) return hit;
  const cam = await prisma.camera.findFirst({ where: { id: cameraId, tenantId, isActive: true, deletedAt: null }, select: { id: true } });
  decisions.set(key, !!cam);
  return !!cam;
};

const normalise = (p: string) => p.replace(/^\/+|\/+$/g, '');
export const samePath = (a: string, b: string) => normalise(a) === normalise(b);
