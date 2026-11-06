"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.appUrl = exports.getTenantStripe = exports.buildStripe = void 0;
const stripe_1 = __importDefault(require("stripe"));
const db_1 = __importDefault(require("../configs/db"));
const crypto_1 = require("../utils/crypto");
// STRIPE_API_BASE points the SDK at another host (used only for local testing against a mock server)
const buildStripe = (secretKey) => {
    const config = { maxNetworkRetries: 1, timeout: 20000 };
    const base = process.env.STRIPE_API_BASE;
    if (base) {
        const url = new URL(base);
        config.host = url.hostname;
        config.port = url.port;
        config.protocol = url.protocol.replace(':', '');
    }
    return new stripe_1.default(secretKey, config);
};
exports.buildStripe = buildStripe;
/** The Stripe client for one society's own account, or null if that society has not connected Stripe. */
const getTenantStripe = async (tenantId) => {
    const tenant = await db_1.default.tenant.findUnique({
        where: { id: tenantId },
        select: { id: true, slug: true, name: true, currency: true, stripeSecretKeyEnc: true, stripeWebhookSecretEnc: true },
    });
    if (!tenant?.stripeSecretKeyEnc)
        return null;
    return {
        stripe: (0, exports.buildStripe)((0, crypto_1.decrypt)(tenant.stripeSecretKeyEnc)),
        tenant: {
            id: tenant.id,
            slug: tenant.slug,
            name: tenant.name,
            currency: tenant.currency || 'inr',
            webhookSecret: tenant.stripeWebhookSecretEnc ? (0, crypto_1.decrypt)(tenant.stripeWebhookSecretEnc) : null,
        },
    };
};
exports.getTenantStripe = getTenantStripe;
/** Where the web app lives, for links in emails/QR codes and Stripe return URLs. */
const appUrl = (req) => (process.env.FRONTEND_URL || req?.headers.origin || 'http://localhost:3000').replace(/\/$/, '');
exports.appUrl = appUrl;
