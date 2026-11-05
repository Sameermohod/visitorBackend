import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import prisma from '../../configs/db';
import ApiResponse from '../../utils/apiResponse';
import logger from '../../configs/logger';
import { sendEmail, getChargeNoticeTemplate } from '../../utils/emailService';
import { appUrl } from '../../services/stripe';
import { notifyUsers, recordPayment, rupees } from '../../services/payments';

const round2 = (n: number) => Math.round(n * 100) / 100;

const issueSchema = z.object({
  title: z.string().min(3).max(150),
  kind: z.enum(['MAINTENANCE', 'FUNCTION', 'OTHER']).default('MAINTENANCE'),
  description: z.string().max(1000).optional().or(z.literal('')),
  amount: z.number().positive().max(10_000_000),
  gstRate: z.number().min(0).max(100).default(0),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

const offlineSchema = z.object({
  method: z.enum(['CASH', 'CHEQUE', 'BANK_TRANSFER', 'UPI']),
  amount: z.number().positive().optional(),
  reference: z.string().max(100).optional(),
});

const dueText = (d: Date) => d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

// Residents (users) living in the flats of a set of invoices
const residentsOfInvoices = async (tenantId: string, flatIds: string[]) =>
  prisma.resident.findMany({ relationLoadStrategy: 'join',
    where: { tenantId, flatId: { in: flatIds }, deletedAt: null },
    select: { flatId: true, user: { select: { id: true, email: true, firstName: true } } },
  });

const emailResidents = (
  residents: { user: { email: string; firstName: string } | null }[],
  societyName: string,
  charge: { id: string; title: string; description: string | null },
  amountText: string,
  due: Date,
  payUrl: string,
  reminder = false
) => {
  for (const r of residents) {
    if (!r.user?.email) continue;
    sendEmail(
      r.user.email,
      `${reminder ? '⏰ Reminder' : '📢 New charge'}: ${charge.title} - ${amountText}`,
      getChargeNoticeTemplate(r.user.firstName, societyName, charge.title, charge.description, amountText, dueText(due), payUrl, reminder)
    ).catch((err) => logger.error(`SMTP: Failed to send charge email to ${r.user?.email}:`, err));
  }
};

export class ChargesController {
  // Issue a charge to every occupied flat and notify each resident
  static async issue(req: Request, res: Response, next: NextFunction) {
    try {
      const tenantId = req.tenantId!;
      const data = issueSchema.parse(req.body);
      const due = new Date(data.dueDate);

      const flats = await prisma.flat.findMany({
        where: { tenantId, deletedAt: null, residents: { some: { deletedAt: null } } },
        select: { id: true, number: true },
      });
      if (!flats.length) {
        return ApiResponse.error(res, 'No occupied flats to bill yet. Add residents first.', null, 400);
      }

      const gst = round2((data.amount * data.gstRate) / 100);
      const total = round2(data.amount + gst);
      const stamp = new Date().toISOString().slice(0, 7).replace('-', '');
      const today = new Date(new Date().toISOString().slice(0, 10));

      const charge = await prisma.$transaction(async (tx) => {
        const created = await tx.charge.create({
          data: {
            tenantId,
            title: data.title,
            kind: data.kind,
            description: data.description || null,
            amount: data.amount,
            gstRate: data.gstRate,
            dueDate: due,
            createdBy: req.user!.id,
          },
        });
        await tx.maintenanceInvoice.createMany({
          data: flats.map((flat) => ({
            tenantId,
            flatId: flat.id,
            chargeId: created.id,
            title: data.title,
            kind: data.kind,
            invoiceNumber: `INV-${stamp}-${flat.number.replace(/[^A-Za-z0-9]/g, '')}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
            billPeriodStart: today,
            billPeriodEnd: due,
            maintenanceAmount: data.amount,
            gstAmount: gst,
            totalAmount: total,
            dueDate: due,
          })),
        });
        return created;
      }, { timeout: 20000 });

      // Tell every resident: in-app notification + email with a link to pay
      const [residents, tenant] = await Promise.all([
        residentsOfInvoices(tenantId, flats.map((f) => f.id)),
        prisma.tenant.findUnique({ where: { id: tenantId }, select: { name: true } }),
      ]);
      const amountText = rupees(total);
      await notifyUsers(
        tenantId,
        residents.map((r) => r.user.id),
        `New charge: ${data.title}`,
        `${amountText} is due by ${dueText(due)}. Open Bills to pay.`,
        'CHARGE'
      );
      emailResidents(residents, tenant?.name ?? 'Your society', charge, amountText, due, `${appUrl(req)}/#/billing?charge=${charge.id}`);

      logger.info(`Charges: ${req.user!.email} issued "${data.title}" to ${flats.length} flats.`);
      return ApiResponse.success(
        res,
        { charge, invoicesCreated: flats.length, residentsNotified: new Set(residents.map((r) => r.user.id)).size },
        `Charge issued to ${flats.length} flats. Residents have been notified.`,
        201
      );
    } catch (error) {
      next(error);
    }
  }

  // All issued charges with how much has been collected
  static async list(req: Request, res: Response, next: NextFunction) {
    try {
      const tenantId = req.tenantId!;
      const charges = await prisma.charge.findMany({
        where: { tenantId, deletedAt: null },
        orderBy: { createdAt: 'desc' },
        take: 100,
      });
      const ids = charges.map((c) => c.id);

      const [totals, paid] = await Promise.all([
        prisma.maintenanceInvoice.groupBy({
          by: ['chargeId'],
          where: { tenantId, chargeId: { in: ids }, deletedAt: null },
          _count: { _all: true },
          _sum: { totalAmount: true, paidAmount: true },
        }),
        prisma.maintenanceInvoice.groupBy({
          by: ['chargeId'],
          where: { tenantId, chargeId: { in: ids }, deletedAt: null, status: 'PAID' },
          _count: { _all: true },
        }),
      ]);

      const data = charges.map((c) => {
        const t = totals.find((x) => x.chargeId === c.id);
        return {
          ...c,
          flatsCount: t?._count._all ?? 0,
          flatsPaid: paid.find((x) => x.chargeId === c.id)?._count._all ?? 0,
          totalBilled: Number(t?._sum.totalAmount ?? 0),
          totalCollected: Number(t?._sum.paidAmount ?? 0),
        };
      });
      return ApiResponse.success(res, data, 'Charges loaded');
    } catch (error) {
      next(error);
    }
  }

  // One charge with its per-flat invoices
  static async get(req: Request, res: Response, next: NextFunction) {
    try {
      const tenantId = req.tenantId!;
      const charge = await prisma.charge.findFirst({ where: { id: req.params.chargeId, tenantId, deletedAt: null } });
      if (!charge) return ApiResponse.error(res, 'Charge not found.', null, 404);

      const invoices = await prisma.maintenanceInvoice.findMany({ relationLoadStrategy: 'join',
        where: { chargeId: charge.id, tenantId, deletedAt: null },
        select: {
          id: true, invoiceNumber: true, totalAmount: true, paidAmount: true, status: true, dueDate: true,
          flat: {
            select: {
              number: true,
              residents: { where: { deletedAt: null }, select: { user: { select: { firstName: true, lastName: true } } } },
            },
          },
        },
        orderBy: { flat: { number: 'asc' } },
      });
      return ApiResponse.success(res, { charge, invoices }, 'Charge loaded');
    } catch (error) {
      next(error);
    }
  }

  // Admin/Secretary records a payment received outside the app (cash, cheque, bank transfer, UPI)
  static async recordOffline(req: Request, res: Response, next: NextFunction) {
    try {
      const tenantId = req.tenantId!;
      const data = offlineSchema.parse(req.body);

      const invoice = await prisma.maintenanceInvoice.findFirst({
        where: { id: req.params.invoiceId, tenantId, deletedAt: null },
      });
      if (!invoice) return ApiResponse.error(res, 'Invoice not found.', null, 404);
      if (invoice.status === 'PAID') return ApiResponse.error(res, 'This invoice is already fully paid.', null, 400);

      const remaining = round2(Number(invoice.totalAmount) - Number(invoice.paidAmount));
      const amount = round2(data.amount ?? remaining);
      if (amount > remaining + 0.001) {
        return ApiResponse.error(res, `Amount cannot be more than the ${rupees(remaining)} still due.`, null, 400);
      }

      const result = await recordPayment({
        tenantId,
        invoiceId: invoice.id,
        userId: req.user!.id,
        amount,
        method: data.method,
        provider: 'MANUAL',
        reference: data.reference,
        transactionId: `MAN-${invoice.id.slice(0, 8)}-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
      });

      const residents = await residentsOfInvoices(tenantId, [invoice.flatId]);
      await notifyUsers(
        tenantId,
        residents.map((r) => r.user.id),
        'Payment received',
        `${rupees(amount)} received (${data.method.replace('_', ' ').toLowerCase()}) for ${invoice.title ?? 'maintenance'}.`,
        'PAYMENT'
      );

      return ApiResponse.success(res, result.invoice, 'Payment recorded.', 201);
    } catch (error) {
      next(error);
    }
  }

  // Remind everyone who has not paid yet
  static async remind(req: Request, res: Response, next: NextFunction) {
    try {
      const tenantId = req.tenantId!;
      const charge = await prisma.charge.findFirst({ where: { id: req.params.chargeId, tenantId, deletedAt: null } });
      if (!charge) return ApiResponse.error(res, 'Charge not found.', null, 404);

      const unpaid = await prisma.maintenanceInvoice.findMany({
        where: { chargeId: charge.id, tenantId, deletedAt: null, status: { not: 'PAID' } },
        select: { flatId: true, totalAmount: true, paidAmount: true },
      });
      if (!unpaid.length) return ApiResponse.success(res, { reminded: 0 }, 'Everyone has already paid.');

      const [residents, tenant] = await Promise.all([
        residentsOfInvoices(tenantId, unpaid.map((i) => i.flatId)),
        prisma.tenant.findUnique({ where: { id: tenantId }, select: { name: true } }),
      ]);
      const total = Number(charge.amount) + (Number(charge.amount) * Number(charge.gstRate)) / 100;

      await notifyUsers(
        tenantId,
        residents.map((r) => r.user.id),
        `Reminder: ${charge.title}`,
        `Still unpaid. Due ${dueText(charge.dueDate)}. Open Bills to pay.`,
        'CHARGE'
      );
      emailResidents(residents, tenant?.name ?? 'Your society', charge, rupees(round2(total)), charge.dueDate, `${appUrl(req)}/#/billing?charge=${charge.id}`, true);

      return ApiResponse.success(res, { reminded: unpaid.length }, `Reminder sent for ${unpaid.length} unpaid flats.`);
    } catch (error) {
      next(error);
    }
  }

  // Cancel a charge issued by mistake — only while nothing has been paid
  static async cancel(req: Request, res: Response, next: NextFunction) {
    try {
      const tenantId = req.tenantId!;
      const charge = await prisma.charge.findFirst({ where: { id: req.params.chargeId, tenantId, deletedAt: null } });
      if (!charge) return ApiResponse.error(res, 'Charge not found.', null, 404);

      const paid = await prisma.maintenanceInvoice.count({
        where: { chargeId: charge.id, tenantId, deletedAt: null, paidAmount: { gt: 0 } },
      });
      if (paid > 0) {
        return ApiResponse.error(res, `${paid} flat(s) have already paid, so this charge can no longer be cancelled.`, null, 400);
      }

      const now = new Date();
      await prisma.$transaction([
        prisma.maintenanceInvoice.updateMany({ where: { chargeId: charge.id, tenantId }, data: { deletedAt: now } }),
        prisma.charge.update({ where: { id: charge.id }, data: { deletedAt: now } }),
      ]);
      return ApiResponse.success(res, null, 'Charge cancelled.');
    } catch (error) {
      next(error);
    }
  }
}

export default ChargesController;
