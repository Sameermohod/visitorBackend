"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.startAutopayScheduler = exports.runAutopay = void 0;
const db_1 = __importDefault(require("../configs/db"));
const logger_1 = __importDefault(require("../configs/logger"));
const emailService_1 = require("../utils/emailService");
const stripe_1 = require("./stripe");
const crypto_1 = require("../utils/crypto");
const payments_1 = require("./payments");
const DAY_MS = 24 * 60 * 60 * 1000;
const round2 = (n) => Math.round(n * 100) / 100;
/**
 * Charges saved cards for monthly MAINTENANCE bills that are due today or overdue.
 * - Only residents who switched autopay on are charged; function fees stay manual.
 * - Each invoice is tried at most once every 24 hours, and Stripe's idempotency key stops double charges.
 */
const runAutopay = async (now = new Date()) => {
    const summary = { charged: 0, failed: 0, skipped: 0 };
    const endOfToday = new Date(now.toISOString().slice(0, 10));
    endOfToday.setUTCHours(23, 59, 59, 999);
    const retryBefore = new Date(now.getTime() - DAY_MS);
    const tenants = await db_1.default.tenant.findMany({
        where: { isActive: true, deletedAt: null, stripeSecretKeyEnc: { not: null } },
        select: { id: true, name: true, currency: true, stripeSecretKeyEnc: true },
    });
    for (const tenant of tenants) {
        const stripe = (0, stripe_1.buildStripe)((0, crypto_1.decrypt)(tenant.stripeSecretKeyEnc));
        const invoices = await db_1.default.maintenanceInvoice.findMany({
            where: {
                tenantId: tenant.id,
                deletedAt: null,
                kind: 'MAINTENANCE',
                status: { in: ['UNPAID', 'PARTIALLY_PAID', 'OVERDUE'] },
                dueDate: { lte: endOfToday },
                OR: [{ autopayAttemptedAt: null }, { autopayAttemptedAt: { lt: retryBefore } }],
                flat: { residents: { some: { deletedAt: null, user: { autopay: { is: { enabled: true } } } } } },
            },
            include: {
                flat: {
                    select: {
                        number: true,
                        residents: {
                            where: { deletedAt: null, user: { autopay: { is: { enabled: true } } } },
                            select: { user: { select: { id: true, email: true, firstName: true, autopay: true } } },
                        },
                    },
                },
            },
            take: 500,
        });
        for (const invoice of invoices) {
            const payer = invoice.flat.residents.map((r) => r.user).find((u) => u.autopay?.enabled && u.autopay.stripePaymentMethodId);
            const enrollment = payer?.autopay;
            if (!payer || !enrollment?.stripePaymentMethodId) {
                summary.skipped++;
                continue;
            }
            const remaining = round2(Number(invoice.totalAmount) - Number(invoice.paidAmount));
            if (remaining <= 0)
                continue;
            // Mark the attempt first so a crash can never cause a second charge in the same day
            await db_1.default.maintenanceInvoice.update({ where: { id: invoice.id }, data: { autopayAttemptedAt: now } });
            try {
                const intent = await stripe.paymentIntents.create({
                    amount: Math.round(remaining * 100),
                    currency: tenant.currency,
                    customer: enrollment.stripeCustomerId,
                    payment_method: enrollment.stripePaymentMethodId,
                    off_session: true,
                    confirm: true,
                    description: `${invoice.title ?? 'Maintenance'} · Flat ${invoice.flat.number} · ${invoice.invoiceNumber}`,
                    metadata: { tenantId: tenant.id, invoiceId: invoice.id, userId: payer.id, source: 'autopay' },
                }, { idempotencyKey: `autopay-${invoice.id}-${Math.round(remaining * 100)}-${now.toISOString().slice(0, 10)}` });
                if (intent.status !== 'succeeded')
                    throw new Error(`Payment is ${intent.status}.`);
                await (0, payments_1.recordPayment)({
                    tenantId: tenant.id,
                    invoiceId: invoice.id,
                    userId: payer.id,
                    amount: remaining,
                    method: 'AUTOPAY',
                    provider: 'STRIPE',
                    transactionId: `STRIPE-${intent.id}`,
                    reference: intent.id,
                });
                await db_1.default.autopayEnrollment.update({ where: { userId: payer.id }, data: { lastError: null } });
                await (0, payments_1.notifyUsers)(tenant.id, [payer.id], 'Autopay payment made', `${(0, payments_1.rupees)(remaining)} was charged to your ${enrollment.brand ?? 'card'} •••• ${enrollment.last4 ?? ''} for ${invoice.title ?? 'maintenance'}.`, 'PAYMENT');
                summary.charged++;
            }
            catch (e) {
                summary.failed++;
                const reason = e?.raw?.message || e?.message || 'The card was declined.';
                logger_1.default.warn(`Autopay: charge failed for invoice ${invoice.invoiceNumber}: ${reason}`);
                await db_1.default.autopayEnrollment.update({ where: { userId: payer.id }, data: { lastError: reason } }).catch(() => undefined);
                await (0, payments_1.notifyUsers)(tenant.id, [payer.id], 'Autopay failed', `We could not charge your card for ${invoice.title ?? 'maintenance'} (${(0, payments_1.rupees)(remaining)}). Please pay it manually or update your card.`, 'PAYMENT').catch(() => undefined);
                (0, emailService_1.sendEmail)(payer.email, `⚠️ Autopay failed: ${invoice.title ?? 'Maintenance'}`, (0, emailService_1.getAutopayFailedTemplate)(payer.firstName, invoice.title ?? 'Maintenance', (0, payments_1.rupees)(remaining), reason, `${(process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/$/, '')}/#/billing`)).catch(() => undefined);
            }
        }
    }
    if (summary.charged || summary.failed)
        logger_1.default.info(`Autopay run finished: ${JSON.stringify(summary)}`);
    return summary;
};
exports.runAutopay = runAutopay;
let timer = null;
/** Checks every 6 hours (and shortly after boot). Disable with AUTOPAY_ENABLED=false. */
const startAutopayScheduler = () => {
    if (process.env.AUTOPAY_ENABLED === 'false' || timer)
        return;
    const tick = () => (0, exports.runAutopay)().catch((e) => logger_1.default.error('Autopay run crashed:', e));
    setTimeout(tick, 60 * 1000).unref();
    timer = setInterval(tick, 6 * 60 * 60 * 1000);
    timer.unref();
    logger_1.default.info('Autopay scheduler started (checks every 6 hours).');
};
exports.startAutopayScheduler = startAutopayScheduler;
