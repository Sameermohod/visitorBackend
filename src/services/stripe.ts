import { Request } from 'express';
import Stripe from 'stripe';
import prisma from '../configs/db';
import { decrypt } from '../utils/crypto';

// STRIPE_API_BASE points the SDK at another host (used only for local testing against a mock server)
export const buildStripe = (secretKey: string): Stripe => {
  const config: Stripe.StripeConfig = { maxNetworkRetries: 1, timeout: 20000 };
  const base = process.env.STRIPE_API_BASE;
  if (base) {
    const url = new URL(base);
    config.host = url.hostname;
    config.port = url.port;
    config.protocol = url.protocol.replace(':', '') as 'http' | 'https';
  }
  return new Stripe(secretKey, config);
};

export interface TenantStripe {
  stripe: Stripe;
  tenant: { id: string; slug: string; name: string; currency: string; webhookSecret: string | null };
}

/** The Stripe client for one society's own account, or null if that society has not connected Stripe. */
export const getTenantStripe = async (tenantId: string): Promise<TenantStripe | null> => {
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { id: true, slug: true, name: true, currency: true, stripeSecretKeyEnc: true, stripeWebhookSecretEnc: true },
  });
  if (!tenant?.stripeSecretKeyEnc) return null;
  return {
    stripe: buildStripe(decrypt(tenant.stripeSecretKeyEnc)),
    tenant: {
      id: tenant.id,
      slug: tenant.slug,
      name: tenant.name,
      currency: tenant.currency || 'inr',
      webhookSecret: tenant.stripeWebhookSecretEnc ? decrypt(tenant.stripeWebhookSecretEnc) : null,
    },
  };
};

/** Where the web app lives, for links in emails/QR codes and Stripe return URLs. */
export const appUrl = (req?: Request): string =>
  (process.env.FRONTEND_URL || (req?.headers.origin as string) || 'http://localhost:3000').replace(/\/$/, '');
