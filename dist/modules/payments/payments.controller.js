"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PaymentsController = void 0;
const zod_1 = require("zod");
const db_1 = __importDefault(require("../../configs/db"));
const apiResponse_1 = __importDefault(require("../../utils/apiResponse"));
const logger_1 = __importDefault(require("../../configs/logger"));
const crypto_1 = require("../../utils/crypto");
const stripe_1 = require("../../services/stripe");
const payments_1 = require("../../services/payments");
const autopaySetup_1 = require("../../services/autopaySetup");
const round2 = (n) => Math.round(n * 100) / 100;
const stripeSettingsSchema = zod_1.z.object({
    secretKey: zod_1.z.string().trim().regex(/^(sk|rk)_(test|live)_[A-Za-z0-9]+$/, 'That does not look like a Stripe secret key (it starts with sk_test_ or sk_live_).'),
    webhookSecret: zod_1.z.string().trim().regex(/^whsec_[A-Za-z0-9]+$/, 'The webhook signing secret starts with whsec_.').optional().or(zod_1.z.literal('')),
});
const webhookUrlFor = (req, slug) => `${(process.env.API_PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '')}/api/v1/payments/stripe/webhook/${slug}`;
/** The resident record that links the signed-in user to the invoice's flat (a resident may only pay their own flat's bills). */
const ownsInvoice = (tenantId, userId, flatId) => db_1.default.resident.findFirst({ where: { tenantId, userId, flatId, deletedAt: null }, select: { id: true } });
/** Records the payment from a paid Checkout session. Safe to call many times for the same session. */
const recordCheckoutPayment = async (tenantId, session) => {
    const invoiceId = session.metadata?.invoiceId;
    const userId = session.metadata?.userId;
    const intentId = typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id;
    if (session.payment_status !== 'paid' || !invoiceId || !userId || !intentId)
        return null;
    const result = await (0, payments_1.recordPayment)({
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
        await (0, payments_1.notifyUsers)(tenantId, [userId], 'Payment received', `${(0, payments_1.rupees)((session.amount_total ?? 0) / 100)} paid for ${result.invoice.title ?? 'maintenance'}. Thank you!`, 'PAYMENT');
    }
    return result;
};
class PaymentsController {
    /* ---------------- Public config for the app ---------------- */
    static async config(req, res, next) {
        try {
            const tenant = await db_1.default.tenant.findUnique({
                where: { id: req.tenantId },
                select: { stripeSecretKeyEnc: true, stripeMode: true, stripeAccountName: true, currency: true },
            });
            return apiResponse_1.default.success(res, {
                onlinePayments: !!tenant?.stripeSecretKeyEnc,
                mode: tenant?.stripeMode ?? null,
                accountName: tenant?.stripeAccountName ?? null,
                currency: tenant?.currency ?? 'inr',
                demoPayments: process.env.ALLOW_DEMO_PAYMENTS === 'true',
            });
        }
        catch (error) {
            next(error);
        }
    }
    /* ---------------- Society owner: connect their own Stripe account ---------------- */
    static async getStripeSettings(req, res, next) {
        try {
            const tenant = await db_1.default.tenant.findUnique({
                where: { id: req.tenantId },
                select: { slug: true, stripeSecretKeyEnc: true, stripeWebhookSecretEnc: true, stripeAccountName: true, stripeMode: true, stripeConnectedAt: true },
            });
            if (!tenant)
                return apiResponse_1.default.error(res, 'Society not found.', null, 404);
            return apiResponse_1.default.success(res, {
                connected: !!tenant.stripeSecretKeyEnc,
                accountName: tenant.stripeAccountName,
                mode: tenant.stripeMode,
                connectedAt: tenant.stripeConnectedAt,
                hasWebhookSecret: !!tenant.stripeWebhookSecretEnc,
                webhookUrl: webhookUrlFor(req, tenant.slug),
            });
        }
        catch (error) {
            next(error);
        }
    }
    static async saveStripeSettings(req, res, next) {
        try {
            const tenantId = req.tenantId;
            const data = stripeSettingsSchema.parse(req.body);
            // Prove the key works before saving it
            const stripe = (0, stripe_1.buildStripe)(data.secretKey);
            try {
                await stripe.balance.retrieve();
            }
            catch (e) {
                return apiResponse_1.default.error(res, `Stripe did not accept this key${e?.message ? `: ${e.message}` : '.'}`, null, 400);
            }
            let accountName = null;
            try {
                const account = await stripe.accounts.retrieve();
                accountName = account.business_profile?.name || account.settings?.dashboard?.display_name || account.email || null;
            }
            catch {
                /* restricted keys may not read the account profile; that's fine */
            }
            await db_1.default.tenant.update({
                where: { id: tenantId },
                data: {
                    stripeSecretKeyEnc: (0, crypto_1.encrypt)(data.secretKey),
                    ...(data.webhookSecret ? { stripeWebhookSecretEnc: (0, crypto_1.encrypt)(data.webhookSecret) } : {}),
                    stripeAccountName: accountName,
                    stripeMode: data.secretKey.includes('_live_') ? 'live' : 'test',
                    stripeConnectedAt: new Date(),
                },
            });
            logger_1.default.info(`Payments: ${req.user.email} connected a Stripe account for tenant ${tenantId}.`);
            return apiResponse_1.default.success(res, { connected: true, accountName, mode: data.secretKey.includes('_live_') ? 'live' : 'test' }, 'Stripe account connected.');
        }
        catch (error) {
            next(error);
        }
    }
    static async disconnectStripe(req, res, next) {
        try {
            const tenantId = req.tenantId;
            await db_1.default.$transaction([
                db_1.default.tenant.update({
                    where: { id: tenantId },
                    data: { stripeSecretKeyEnc: null, stripeWebhookSecretEnc: null, stripeAccountName: null, stripeMode: null, stripeConnectedAt: null },
                }),
                // Saved cards belong to the old Stripe account and can no longer be charged
                db_1.default.autopayEnrollment.updateMany({ where: { tenantId }, data: { enabled: false, stripePaymentMethodId: null, last4: null, brand: null } }),
            ]);
            return apiResponse_1.default.success(res, null, 'Stripe account disconnected. Online payments and autopay are switched off.');
        }
        catch (error) {
            next(error);
        }
    }
    /* ---------------- Resident: pay an invoice ---------------- */
    static async checkout(req, res, next) {
        try {
            const tenantId = req.tenantId;
            const { invoiceId } = zod_1.z.object({ invoiceId: zod_1.z.string().uuid() }).parse(req.body);
            const connected = await (0, stripe_1.getTenantStripe)(tenantId);
            if (!connected)
                return apiResponse_1.default.error(res, 'Online payments are not set up for your society yet.', null, 400);
            const invoice = await db_1.default.maintenanceInvoice.findFirst({
                where: { id: invoiceId, tenantId, deletedAt: null },
                include: { flat: { select: { number: true } } },
            });
            if (!invoice)
                return apiResponse_1.default.error(res, 'Invoice not found.', null, 404);
            if (!(await ownsInvoice(tenantId, req.user.id, invoice.flatId))) {
                return apiResponse_1.default.error(res, 'You can only pay bills for your own flat.', null, 403);
            }
            const remaining = round2(Number(invoice.totalAmount) - Number(invoice.paidAmount));
            if (invoice.status === 'PAID' || remaining <= 0)
                return apiResponse_1.default.error(res, 'This bill is already paid.', null, 400);
            const base = (0, stripe_1.appUrl)(req);
            const metadata = { tenantId, invoiceId: invoice.id, userId: req.user.id };
            const session = await connected.stripe.checkout.sessions.create({
                mode: 'payment',
                client_reference_id: invoice.id,
                customer_email: req.user.email,
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
            return apiResponse_1.default.success(res, { url: session.url, sessionId: session.id }, 'Checkout ready');
        }
        catch (error) {
            next(error);
        }
    }
    // The resident returns from Stripe: confirm with Stripe (never trust the browser) and record the payment
    static async confirm(req, res, next) {
        try {
            const tenantId = req.tenantId;
            const { sessionId } = zod_1.z.object({ sessionId: zod_1.z.string().min(5) }).parse(req.body);
            const connected = await (0, stripe_1.getTenantStripe)(tenantId);
            if (!connected)
                return apiResponse_1.default.error(res, 'Online payments are not set up for your society.', null, 400);
            const session = await connected.stripe.checkout.sessions.retrieve(sessionId);
            if (session.mode !== 'payment' || session.metadata?.tenantId !== tenantId || session.metadata?.userId !== req.user.id) {
                return apiResponse_1.default.error(res, 'This payment does not belong to your account.', null, 403);
            }
            if (session.payment_status !== 'paid') {
                return apiResponse_1.default.error(res, 'The payment has not been completed yet.', null, 409);
            }
            const result = await recordCheckoutPayment(tenantId, session);
            return apiResponse_1.default.success(res, result?.invoice ?? null, 'Payment confirmed. Thank you!');
        }
        catch (error) {
            next(error);
        }
    }
    /* ---------------- Stripe webhook (one URL per society) ---------------- */
    // Mounted in index.ts with a raw body parser, because Stripe signs the exact bytes it sends
    static async webhook(req, res) {
        const tenant = await db_1.default.tenant.findUnique({ where: { slug: req.params.slug }, select: { id: true } });
        if (!tenant)
            return res.status(404).json({ received: false });
        const connected = await (0, stripe_1.getTenantStripe)(tenant.id);
        if (!connected?.tenant.webhookSecret) {
            return res.status(400).json({ received: false, message: 'Webhook signing secret is not configured for this society.' });
        }
        let event;
        try {
            event = connected.stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], connected.tenant.webhookSecret);
        }
        catch (e) {
            logger_1.default.warn(`Payments: rejected webhook for ${req.params.slug}: ${e.message}`);
            return res.status(400).json({ received: false, message: 'Invalid signature.' });
        }
        try {
            if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
                const session = event.data.object;
                if (session.mode === 'payment' && session.metadata?.tenantId === tenant.id) {
                    await recordCheckoutPayment(tenant.id, session);
                }
                else if (session.mode === 'setup' && session.metadata?.tenantId === tenant.id) {
                    await (0, autopaySetup_1.saveAutopayFromSession)(connected.stripe, tenant.id, session.id);
                }
            }
            return res.json({ received: true });
        }
        catch (e) {
            logger_1.default.error(`Payments: webhook processing failed for ${req.params.slug}:`, e);
            return res.status(500).json({ received: false }); // Stripe retries on 5xx
        }
    }
    /* ---------------- Autopay ---------------- */
    static async getAutopay(req, res, next) {
        try {
            const e = await db_1.default.autopayEnrollment.findUnique({ where: { userId: req.user.id } });
            return apiResponse_1.default.success(res, {
                enabled: !!e?.enabled,
                brand: e?.brand ?? null,
                last4: e?.last4 ?? null,
                lastError: e?.lastError ?? null,
            });
        }
        catch (error) {
            next(error);
        }
    }
    static async setupAutopay(req, res, next) {
        try {
            const tenantId = req.tenantId;
            const connected = await (0, stripe_1.getTenantStripe)(tenantId);
            if (!connected)
                return apiResponse_1.default.error(res, 'Online payments are not set up for your society yet.', null, 400);
            const user = req.user;
            let enrollment = await db_1.default.autopayEnrollment.findUnique({ where: { userId: user.id } });
            if (!enrollment) {
                const customer = await connected.stripe.customers.create({
                    email: user.email,
                    name: `${user.firstName} ${user.lastName}`.trim(),
                    metadata: { tenantId, userId: user.id },
                });
                enrollment = await db_1.default.autopayEnrollment.create({
                    data: { tenantId, userId: user.id, stripeCustomerId: customer.id, enabled: false },
                });
            }
            const base = (0, stripe_1.appUrl)(req);
            const session = await connected.stripe.checkout.sessions.create({
                mode: 'setup',
                currency: connected.tenant.currency,
                customer: enrollment.stripeCustomerId,
                payment_method_types: ['card'],
                metadata: { tenantId, userId: user.id, purpose: 'autopay' },
                success_url: `${base}/#/billing?autopay=1&session_id={CHECKOUT_SESSION_ID}`,
                cancel_url: `${base}/#/billing`,
            });
            return apiResponse_1.default.success(res, { url: session.url, sessionId: session.id }, 'Autopay setup ready');
        }
        catch (error) {
            next(error);
        }
    }
    static async confirmAutopay(req, res, next) {
        try {
            const tenantId = req.tenantId;
            const { sessionId } = zod_1.z.object({ sessionId: zod_1.z.string().min(5) }).parse(req.body);
            const connected = await (0, stripe_1.getTenantStripe)(tenantId);
            if (!connected)
                return apiResponse_1.default.error(res, 'Online payments are not set up for your society.', null, 400);
            const preview = await connected.stripe.checkout.sessions.retrieve(sessionId);
            if (preview.metadata?.userId !== req.user.id) {
                return apiResponse_1.default.error(res, 'This setup does not belong to your account.', null, 403);
            }
            const enrollment = await (0, autopaySetup_1.saveAutopayFromSession)(connected.stripe, tenantId, sessionId);
            if (!enrollment)
                return apiResponse_1.default.error(res, 'Your card was not saved. Please try again.', null, 409);
            return apiResponse_1.default.success(res, { enabled: true, brand: enrollment.brand, last4: enrollment.last4 }, 'Autopay is on.');
        }
        catch (error) {
            next(error);
        }
    }
    static async disableAutopay(req, res, next) {
        try {
            const enrollment = await db_1.default.autopayEnrollment.findUnique({ where: { userId: req.user.id } });
            if (enrollment?.stripePaymentMethodId) {
                const connected = await (0, stripe_1.getTenantStripe)(req.tenantId);
                // Best effort: also remove the card from Stripe
                await connected?.stripe.paymentMethods.detach(enrollment.stripePaymentMethodId).catch(() => undefined);
            }
            if (enrollment) {
                await db_1.default.autopayEnrollment.update({
                    where: { userId: req.user.id },
                    data: { enabled: false, stripePaymentMethodId: null, brand: null, last4: null, lastError: null },
                });
            }
            return apiResponse_1.default.success(res, null, 'Autopay is off.');
        }
        catch (error) {
            next(error);
        }
    }
}
exports.PaymentsController = PaymentsController;
exports.default = PaymentsController;
