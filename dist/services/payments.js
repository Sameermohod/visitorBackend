"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.notifyUsers = exports.recordPayment = exports.rupees = void 0;
const db_1 = __importDefault(require("../configs/db"));
const responseCache_1 = require("../middleware/responseCache");
const hub_1 = require("../realtime/hub");
const round2 = (n) => Math.round(n * 100) / 100;
const rupees = (n) => `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
exports.rupees = rupees;
/**
 * Records a payment and re-derives the invoice's paid amount and status from all its payments.
 * Idempotent on transactionId.
 */
const recordPayment = async (input) => {
    const run = () => db_1.default.$transaction(async (tx) => {
        const existing = await tx.payment.findUnique({ where: { transactionId: input.transactionId } });
        if (existing) {
            const invoice = await tx.maintenanceInvoice.findUnique({ where: { id: existing.invoiceId } });
            return { payment: existing, invoice: invoice, duplicate: true };
        }
        const invoice = await tx.maintenanceInvoice.findFirst({
            where: { id: input.invoiceId, tenantId: input.tenantId, deletedAt: null },
        });
        if (!invoice)
            throw new Error('Invoice not found.');
        const payment = await tx.payment.create({
            data: {
                tenantId: input.tenantId,
                invoiceId: invoice.id,
                userId: input.userId,
                amount: round2(input.amount),
                paymentMethod: input.method,
                provider: input.provider,
                transactionId: input.transactionId,
                reference: input.reference,
                paymentStatus: 'SUCCESS',
            },
        });
        const sum = await tx.payment.aggregate({
            where: { invoiceId: invoice.id, paymentStatus: 'SUCCESS' },
            _sum: { amount: true },
        });
        const paid = round2(Number(sum._sum.amount || 0));
        const total = Number(invoice.totalAmount);
        const updated = await tx.maintenanceInvoice.update({
            where: { id: invoice.id },
            data: { paidAmount: paid, status: paid >= total ? 'PAID' : paid > 0 ? 'PARTIALLY_PAID' : 'UNPAID' },
        });
        return { payment, invoice: updated, duplicate: false };
    });
    try {
        const result = await run();
        (0, responseCache_1.invalidateTenantCache)(input.tenantId); // webhook / autopay payments arrive outside a normal request
        return result;
    }
    catch (e) {
        // Two requests recorded the same Stripe payment at the same instant: the loser just reads the winner's row
        if (e?.code === 'P2002')
            return run();
        throw e;
    }
};
exports.recordPayment = recordPayment;
/** In-app notifications (the bell in the app header). */
const notifyUsers = async (tenantId, userIds, title, message, type) => {
    const unique = [...new Set(userIds)];
    if (!unique.length)
        return;
    const rows = await db_1.default.notification.createManyAndReturn({
        data: unique.map((userId) => ({ tenantId, userId, title, message, type })),
    });
    (0, responseCache_1.invalidateTenantCache)(tenantId);
    // Push it to anyone who has the app open right now; everyone else finds it in the bell next time
    for (const n of rows) {
        (0, hub_1.emitToUsers)([n.userId], 'notification', {
            id: n.id, title: n.title, message: n.message, type: n.type, isRead: false, createdAt: n.createdAt,
        });
    }
};
exports.notifyUsers = notifyUsers;
