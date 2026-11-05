import prisma from '../configs/db';
import { invalidateTenantCache } from '../middleware/responseCache';
import { emitToUsers } from '../realtime/hub';

const round2 = (n: number) => Math.round(n * 100) / 100;

export const rupees = (n: number | string | { toString(): string }) =>
  `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

interface RecordPaymentInput {
  tenantId: string;
  invoiceId: string;
  userId: string;
  amount: number;
  method: string;
  provider: 'STRIPE' | 'MANUAL';
  /** Globally unique. Recording the same transactionId twice is a no-op, so webhooks/redirects can race safely. */
  transactionId: string;
  reference?: string;
}

/**
 * Records a payment and re-derives the invoice's paid amount and status from all its payments.
 * Idempotent on transactionId.
 */
export const recordPayment = async (input: RecordPaymentInput) => {
  const run = () =>
    prisma.$transaction(async (tx) => {
      const existing = await tx.payment.findUnique({ where: { transactionId: input.transactionId } });
      if (existing) {
        const invoice = await tx.maintenanceInvoice.findUnique({ where: { id: existing.invoiceId } });
        return { payment: existing, invoice: invoice!, duplicate: true };
      }

      const invoice = await tx.maintenanceInvoice.findFirst({
        where: { id: input.invoiceId, tenantId: input.tenantId, deletedAt: null },
      });
      if (!invoice) throw new Error('Invoice not found.');

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
    invalidateTenantCache(input.tenantId); // webhook / autopay payments arrive outside a normal request
    return result;
  } catch (e: any) {
    // Two requests recorded the same Stripe payment at the same instant: the loser just reads the winner's row
    if (e?.code === 'P2002') return run();
    throw e;
  }
};

/** In-app notifications (the bell in the app header). */
export const notifyUsers = async (
  tenantId: string,
  userIds: string[],
  title: string,
  message: string,
  type: string
) => {
  const unique = [...new Set(userIds)];
  if (!unique.length) return;
  const rows = await prisma.notification.createManyAndReturn({
    data: unique.map((userId) => ({ tenantId, userId, title, message, type })),
  });
  invalidateTenantCache(tenantId);
  // Push it to anyone who has the app open right now; everyone else finds it in the bell next time
  for (const n of rows) {
    emitToUsers([n.userId], 'notification', {
      id: n.id, title: n.title, message: n.message, type: n.type, isRead: false, createdAt: n.createdAt,
    });
  }
};
