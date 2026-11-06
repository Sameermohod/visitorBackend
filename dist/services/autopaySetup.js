"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.saveAutopayFromSession = void 0;
const db_1 = __importDefault(require("../configs/db"));
/**
 * Called when a "save my card" Checkout session finishes (from the webhook or the return page).
 * Stores the card on the resident's autopay enrollment and switches autopay on.
 */
const saveAutopayFromSession = async (stripe, tenantId, sessionId) => {
    const session = await stripe.checkout.sessions.retrieve(sessionId, { expand: ['setup_intent'] });
    if (session.mode !== 'setup' || session.metadata?.tenantId !== tenantId || !session.metadata?.userId) {
        throw new Error('This is not an autopay setup session for this society.');
    }
    const setupIntent = session.setup_intent;
    const paymentMethodId = typeof setupIntent?.payment_method === 'string' ? setupIntent.payment_method : setupIntent?.payment_method?.id;
    if (!setupIntent || setupIntent.status !== 'succeeded' || !paymentMethodId) {
        return null; // card not saved (yet)
    }
    const pm = await stripe.paymentMethods.retrieve(paymentMethodId);
    const customerId = typeof session.customer === 'string' ? session.customer : session.customer?.id;
    if (!customerId)
        throw new Error('Stripe did not return a customer for this setup.');
    return db_1.default.autopayEnrollment.upsert({
        where: { userId: session.metadata.userId },
        create: {
            tenantId,
            userId: session.metadata.userId,
            stripeCustomerId: customerId,
            stripePaymentMethodId: paymentMethodId,
            brand: pm.card?.brand ?? null,
            last4: pm.card?.last4 ?? null,
            enabled: true,
        },
        update: {
            stripeCustomerId: customerId,
            stripePaymentMethodId: paymentMethodId,
            brand: pm.card?.brand ?? null,
            last4: pm.card?.last4 ?? null,
            enabled: true,
            lastError: null,
            updatedAt: new Date(),
        },
    });
};
exports.saveAutopayFromSession = saveAutopayFromSession;
