import { Request, Response, NextFunction } from 'express';
import type Stripe from 'stripe';
import { z } from 'zod';
import prisma from '../../configs/db';
import ApiResponse from '../../utils/apiResponse';
import logger from '../../configs/logger';
import { encrypt } from '../../utils/crypto';
import { appUrl, buildStripe, getTenantStripe } from '../../services/stripe';
import { notifyUsers, recordPayment, rupees } from '../../services/payments';
import { saveAutopayFromSession } from '../../services/autopaySetup';

const round2 = (n: number) => Math.round(n * 100) / 100;

const stripeSettingsSchema = z.object({
  secretKey: z.string().trim().regex(/^(sk|rk)_(test|live)_[A-Za-z0-9]+$/, 'That does not look like a Stripe secret key (it starts with sk_test_ or sk_live_).'),
  webhookSecret: z.string().trim().regex(/^whsec_[A-Za-z0-9]+$/, 'The webhook signing secret starts with whsec_.').optional().or(z.literal('')),
});

const webhookUrlFor = (req: Request, slug: string) =>
  `${(process.env.API_PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '')}/api/v1/payments/stripe/webhook/${slug}`;

/** The resident record that links the signed-in user to the invoice's flat (a resident may only pay their own flat's bills). */
const ownsInvoice = (tenantId: string, userId: string, flatId: string) =>
  prisma.resident.findFirst({ where: { tenantId, userId, flatId, deletedAt: null }, select: { id: true } });

/** Records the payment from a paid Checkout session. Safe to call many times for the same session. */
const recordCheckoutPayment = async (tenantId: string, session: Stripe.Checkout.Session) => {
  const invoiceId = session.metadata?.invoiceId;
  const userId = session.metadata?.userId;
  const intentId = typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id;
  if (session.payment_status !== 'paid' || !invoiceId || !userId || !intentId) return null;

  const result = await recordPayment({
    tenantId,
    invoiceId,
    userId,
    amount: (session.amount_total ?? 0) / 100,
    method: 'STRIPE',
    provider: 'STRIPE',
    transactionId: `STRIPE-${intentId}`,
    reference: session.id,
  });

  if (!result.duplicate) {
    await notifyUsers(tenantId, [userId], 'Payment received', `${rupees((session.amount_total ?? 0) / 100)} paid for ${result.invoice.title ?? 'maintenance'}. Thank you!`, 'PAYMENT');
  }
  return result;
};

export class PaymentsController {
  /* ---------------- Public config for the app ---------------- */

  static async config(req: Request, res: Response, next: NextFunction) {
    try {
      const tenant = await prisma.tenant.findUnique({
        where: { id: req.tenantId! },
        select: { stripeSecretKeyEnc: true, stripeMode: true, stripeAccountName: true, currency: true },
      });
      return ApiResponse.success(res, {
        onlinePayments: !!tenant?.stripeSecretKeyEnc,
        mode: tenant?.stripeMode ?? null,
        accountName: tenant?.stripeAccountName ?? null,
        currency: tenant?.currency ?? 'inr',
        demoPayments: process.env.ALLOW_DEMO_PAYMENTS === 'true',
      });
    } catch (error) {
      next(error);
    }
  }

  /* ---------------- Society owner: connect their own Stripe account ---------------- */

  static async getStripeSettings(req: Request, res: Response, next: NextFunction) {
    try {
      const tenant = await prisma.tenant.findUnique({
        where: { id: req.tenantId! },
        select: { slug: true, stripeSecretKeyEnc: true, stripeWebhookSecretEnc: true, stripeAccountName: true, stripeMode: true, stripeConnectedAt: true },
      });
      if (!tenant) return ApiResponse.error(res, 'Society not found.', null, 404);
      return ApiResponse.success(res, {
        connected: !!tenant.stripeSecretKeyEnc,
        accountName: tenant.stripeAccountName,
        mode: tenant.stripeMode,
        connectedAt: tenant.stripeConnectedAt,
        hasWebhookSecret: !!tenant.stripeWebhookSecretEnc,
        webhookUrl: webhookUrlFor(req, tenant.slug),
      });
    } catch (error) {
      next(error);
    }
  }

  static async saveStripeSettings(req: Request, res: Response, next: NextFunction) {
    try {
      const tenantId = req.tenantId!;
      const data = stripeSettingsSchema.parse(req.body);

      // Prove the key works before saving it
      const stripe = buildStripe(data.secretKey);
      try {
        await stripe.balance.retrieve();
      } catch (e: any) {
        return ApiResponse.error(res, `Stripe did not accept this key${e?.message ? `: ${e.message}` : '.'}`, null, 400);
      }

      let accountName: string | null = null;
      try {
        const account = await stripe.accounts.retrieve();
        accountName = account.business_profile?.name || account.settings?.dashboard?.display_name || account.email || null;
      } catch {
        /* restricted keys may not read the account profile; that's fine */
      }

      await prisma.tenant.update({
        where: { id: tenantId },
        data: {
          stripeSecretKeyEnc: encrypt(data.secretKey),
          ...(data.webhookSecret ? { stripeWebhookSecretEnc: encrypt(data.webhookSecret) } : {}),
          stripeAccountName: accountName,
          stripeMode: data.secretKey.includes('_live_') ? 'live' : 'test',
          stripeConnectedAt: new Date(),
        },
      });

      logger.info(`Payments: ${req.user!.email} connected a Stripe account for tenant ${tenantId}.`);
      return ApiResponse.success(res, { connected: true, accountName, mode: data.secretKey.includes('_live_') ? 'live' : 'test' }, 'Stripe account connected.');
    } catch (error) {
      next(error);
    }
  }

  static async disconnectStripe(req: Request, res: Response, next: NextFunction) {
    try {
      const tenantId = req.tenantId!;
      await prisma.$transaction([
        prisma.tenant.update({
          where: { id: tenantId },
          data: { stripeSecretKeyEnc: null, stripeWebhookSecretEnc: null, stripeAccountName: null, stripeMode: null, stripeConnectedAt: null },
        }),
        // Saved cards belong to the old Stripe account and can no longer be charged
        prisma.autopayEnrollment.updateMany({ where: { tenantId }, data: { enabled: false, stripePaymentMethodId: null, last4: null, brand: null } }),
      ]);
      return ApiResponse.success(res, null, 'Stripe account disconnected. Online payments and autopay are switched off.');
    } catch (error) {
      next(error);
    }
  }

  /* ---------------- Resident: pay an invoice ---------------- */

  static async checkout(req: Request, res: Response, next: NextFunction) {
    try {
      const tenantId = req.tenantId!;
      const { invoiceId } = z.object({ invoiceId: z.string().uuid() }).parse(req.body);

      const connected = await getTenantStripe(tenantId);
      if (!connected) return ApiResponse.error(res, 'Online payments are not set up for your society yet.', null, 400);

      const invoice = await prisma.maintenanceInvoice.findFirst({
        where: { id: invoiceId, tenantId, deletedAt: null },
        include: { flat: { select: { number: true } } },
      });
      if (!invoice) return ApiResponse.error(res, 'Invoice not found.', null, 404);
      if (!(await ownsInvoice(tenantId, req.user!.id, invoice.flatId))) {
        return ApiResponse.error(res, 'You can only pay bills for your own flat.', null, 403);
      }

      const remaining = round2(Number(invoice.totalAmount) - Number(invoice.paidAmount));
      if (invoice.status === 'PAID' || remaining <= 0) return ApiResponse.error(res, 'This bill is already paid.', null, 400);

      const base = appUrl(req);
      const metadata = { tenantId, invoiceId: invoice.id, userId: req.user!.id };
      const session = await connected.stripe.checkout.sessions.create({
        mode: 'payment',
        client_reference_id: invoice.id,
        customer_email: req.user!.email,
        line_items: [{
          quantity: 1,
          price_data: {
            currency: connected.tenant.currency,
            unit_amount: Math.round(remaining * 100),
            product_data: { name: invoice.title ?? 'Maintenance', description: `Flat ${invoice.flat.number} · ${invoice.invoiceNumber}` },
          },
        }],
        metadata,
        payment_intent_data: { metadata },
        success_url: `${base}/#/billing?paid=1&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${base}/#/billing`,
      });

      return ApiResponse.success(res, { url: session.url, sessionId: session.id }, 'Checkout ready');
    } catch (error) {
      next(error);
    }
  }

  // The resident returns from Stripe: confirm with Stripe (never trust the browser) and record the payment
  static async confirm(req: Request, res: Response, next: NextFunction) {
    try {
      const tenantId = req.tenantId!;
      const { sessionId } = z.object({ sessionId: z.string().min(5) }).parse(req.body);

      const connected = await getTenantStripe(tenantId);
      if (!connected) return ApiResponse.error(res, 'Online payments are not set up for your society.', null, 400);

      const session = await connected.stripe.checkout.sessions.retrieve(sessionId);
      if (session.mode !== 'payment' || session.metadata?.tenantId !== tenantId || session.metadata?.userId !== req.user!.id) {
        return ApiResponse.error(res, 'This payment does not belong to your account.', null, 403);
      }
      if (session.payment_status !== 'paid') {
        return ApiResponse.error(res, 'The payment has not been completed yet.', null, 409);
      }

      const result = await recordCheckoutPayment(tenantId, session);
      return ApiResponse.success(res, result?.invoice ?? null, 'Payment confirmed. Thank you!');
    } catch (error) {
      next(error);
    }
  }

  /* ---------------- Stripe webhook (one URL per society) ---------------- */

  // Mounted in index.ts with a raw body parser, because Stripe signs the exact bytes it sends
  static async webhook(req: Request, res: Response) {
    const tenant = await prisma.tenant.findUnique({ where: { slug: req.params.slug }, select: { id: true } });
    if (!tenant) return res.status(404).json({ received: false });

    const connected = await getTenantStripe(tenant.id);
    if (!connected?.tenant.webhookSecret) {
      return res.status(400).json({ received: false, message: 'Webhook signing secret is not configured for this society.' });
    }

    let event: Stripe.Event;
    try {
      event = connected.stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'] as string, connected.tenant.webhookSecret);
    } catch (e: any) {
      logger.warn(`Payments: rejected webhook for ${req.params.slug}: ${e.message}`);
      return res.status(400).json({ received: false, message: 'Invalid signature.' });
    }

    try {
      if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
        const session = event.data.object as Stripe.Checkout.Session;
        if (session.mode === 'payment' && session.metadata?.tenantId === tenant.id) {
          await recordCheckoutPayment(tenant.id, session);
        } else if (session.mode === 'setup' && session.metadata?.tenantId === tenant.id) {
          await saveAutopayFromSession(connected.stripe, tenant.id, session.id);
        }
      }
      return res.json({ received: true });
    } catch (e: any) {
      logger.error(`Payments: webhook processing failed for ${req.params.slug}:`, e);
      return res.status(500).json({ received: false }); // Stripe retries on 5xx
    }
  }

  /* ---------------- Autopay ---------------- */

  static async getAutopay(req: Request, res: Response, next: NextFunction) {
    try {
      const e = await prisma.autopayEnrollment.findUnique({ where: { userId: req.user!.id } });
      return ApiResponse.success(res, {
        enabled: !!e?.enabled,
        brand: e?.brand ?? null,
        last4: e?.last4 ?? null,
        lastError: e?.lastError ?? null,
      });
    } catch (error) {
      next(error);
    }
  }

  static async setupAutopay(req: Request, res: Response, next: NextFunction) {
    try {
      const tenantId = req.tenantId!;
      const connected = await getTenantStripe(tenantId);
      if (!connected) return ApiResponse.error(res, 'Online payments are not set up for your society yet.', null, 400);

      const user = req.user!;
      let enrollment = await prisma.autopayEnrollment.findUnique({ where: { userId: user.id } });
      if (!enrollment) {
        const customer = await connected.stripe.customers.create({
          email: user.email,
          name: `${user.firstName} ${user.lastName}`.trim(),
          metadata: { tenantId, userId: user.id },
        });
        enrollment = await prisma.autopayEnrollment.create({
          data: { tenantId, userId: user.id, stripeCustomerId: customer.id, enabled: false },
        });
      }

      const base = appUrl(req);
      const session = await connected.stripe.checkout.sessions.create({
        mode: 'setup',
        currency: connected.tenant.currency,
        customer: enrollment.stripeCustomerId,
        payment_method_types: ['card'],
        metadata: { tenantId, userId: user.id, purpose: 'autopay' },
        success_url: `${base}/#/billing?autopay=1&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${base}/#/billing`,
      });
      return ApiResponse.success(res, { url: session.url, sessionId: session.id }, 'Autopay setup ready');
    } catch (error) {
      next(error);
    }
  }

  static async confirmAutopay(req: Request, res: Response, next: NextFunction) {
    try {
      const tenantId = req.tenantId!;
      const { sessionId } = z.object({ sessionId: z.string().min(5) }).parse(req.body);
      const connected = await getTenantStripe(tenantId);
      if (!connected) return ApiResponse.error(res, 'Online payments are not set up for your society.', null, 400);

      const preview = await connected.stripe.checkout.sessions.retrieve(sessionId);
      if (preview.metadata?.userId !== req.user!.id) {
        return ApiResponse.error(res, 'This setup does not belong to your account.', null, 403);
      }

      const enrollment = await saveAutopayFromSession(connected.stripe, tenantId, sessionId);
      if (!enrollment) return ApiResponse.error(res, 'Your card was not saved. Please try again.', null, 409);
      return ApiResponse.success(res, { enabled: true, brand: enrollment.brand, last4: enrollment.last4 }, 'Autopay is on.');
    } catch (error) {
      next(error);
    }
  }

  static async disableAutopay(req: Request, res: Response, next: NextFunction) {
    try {
      const enrollment = await prisma.autopayEnrollment.findUnique({ where: { userId: req.user!.id } });
      if (enrollment?.stripePaymentMethodId) {
        const connected = await getTenantStripe(req.tenantId!);
        // Best effort: also remove the card from Stripe
        await connected?.stripe.paymentMethods.detach(enrollment.stripePaymentMethodId).catch(() => undefined);
      }
      if (enrollment) {
        await prisma.autopayEnrollment.update({
          where: { userId: req.user!.id },
          data: { enabled: false, stripePaymentMethodId: null, brand: null, last4: null, lastError: null },
        });
      }
      return ApiResponse.success(res, null, 'Autopay is off.');
    } catch (error) {
      next(error);
    }
  }
}

export default PaymentsController;
