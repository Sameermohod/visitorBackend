import { createHash } from 'crypto';
import { RequestHandler } from 'express';
import { emitToTenant } from '../realtime/hub';

// Areas whose writes need no "refresh" signal (chat and notifications push their own events)
const LIVE_SKIP = new Set(['auth', 'messages', 'notifications', 'chat']);

/**
 * Short-lived cache for GET responses.
 *  - Keyed by society + the exact login token + URL, so one person can never be served another person's data.
 *  - Only successful (200) responses are stored, so a token that was never authorised never gets a hit.
 *  - ANY successful write in a society clears that society's cache, so people see their own changes at once.
 *  - Background jobs and webhooks that change data call invalidateTenantCache() themselves.
 * Set API_CACHE_TTL_MS=0 to switch it off.
 */
const TTL_MS = Number(process.env.API_CACHE_TTL_MS ?? 10_000);
const MAX_ENTRIES = 2000;

interface Entry { body: string; expiresAt: number; tenantId: string }
const store = new Map<string, Entry>();
const byTenant = new Map<string, Set<string>>();

export const invalidateTenantCache = (tenantId: string) => {
  const keys = byTenant.get(tenantId);
  if (!keys) return;
  for (const key of keys) store.delete(key);
  byTenant.delete(tenantId);
};

const remember = (key: string, tenantId: string, body: string) => {
  if (store.size >= MAX_ENTRIES) {
    const oldest = store.keys().next().value as string | undefined;
    if (oldest) {
      const e = store.get(oldest);
      store.delete(oldest);
      if (e) byTenant.get(e.tenantId)?.delete(oldest);
    }
  }
  store.set(key, { body, expiresAt: Date.now() + TTL_MS, tenantId });
  if (!byTenant.has(tenantId)) byTenant.set(tenantId, new Set());
  byTenant.get(tenantId)!.add(key);
};

export const responseCache: RequestHandler = (req, res, next) => {
  const tenantId = req.tenantId;
  if (TTL_MS <= 0 || !tenantId) return next();

  // A write: once it succeeds, everything cached for this society may be out of date
  if (req.method !== 'GET') {
    res.on('finish', () => {
      if (res.statusCode >= 400) return;
      invalidateTenantCache(tenantId);
      // Tell open screens in this society that something changed (only the name of the area, never the data),
      // so lists refresh themselves. Chat and notifications have their own events.
      const area = req.originalUrl.split('?')[0].split('/')[3];
      if (area && !LIVE_SKIP.has(area)) emitToTenant(tenantId, 'data:changed', { area, by: req.user?.id ?? null });
    });
    return next();
  }

  // Login/session endpoints are never cached; "Cache-Control: no-cache" forces a fresh read
  if (req.originalUrl.startsWith('/api/v1/auth') || (req.headers['cache-control'] ?? '').includes('no-cache')) return next();

  const token = createHash('sha1').update(req.headers.authorization ?? '').digest('hex');
  const key = `${tenantId}|${token}|${req.originalUrl}`;

  const hit = store.get(key);
  if (hit && hit.expiresAt > Date.now()) {
    res.setHeader('X-Cache', 'HIT');
    return res.status(200).type('application/json').send(hit.body);
  }
  if (hit) store.delete(key);

  const json = res.json.bind(res);
  res.json = (body: any) => {
    if (res.statusCode === 200) remember(key, tenantId, JSON.stringify(body));
    return json(body);
  };
  next();
};
