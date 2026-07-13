import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import prisma from '../../configs/db';
import ApiResponse from '../../utils/apiResponse';
import logger from '../../configs/logger';
import { sendEmail, getInvoiceGeneratedTemplate, getPaymentSuccessTemplate } from '../../utils/emailService';

const generateBillSchema = z.object({
  periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), // "YYYY-MM-DD"
  periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  baseAmount: z.number().min(1),
  gstRate: z.number().min(0).default(18.00), // Default 18% GST in India
});

const payBillSchema = z.object({
  invoiceId: z.string().uuid(),
  amount: z.number().min(1),
  paymentMethod: z.enum(['UPI', 'RAZORPAY', 'CARD', 'CASH']).default('UPI'),
});

export class BillingController {
  // Generate Invoices in batch using the DB stored procedure
  static async generateMonthlyInvoices(req: Request, res: Response, next: NextFunction) {
    try {
      const tenantId = req.tenantId!;
      const data = generateBillSchema.parse(req.body);

      logger.info(`Billing: Invoking DB procedure_generate_monthly_bills for tenant: ${tenantId}`);

      // Execute SQL Procedure
      await prisma.$executeRawUnsafe(
        `CALL procedure_generate_monthly_bills($1::uuid, $2::date, $3::date, $4::numeric, $5::numeric)`,
        tenantId,
        new Date(data.periodStart),
        new Date(data.periodEnd),
        data.baseAmount,
        data.gstRate
      );

      // Verify generated count
      const generated = await prisma.maintenanceInvoice.count({
        where: { tenantId, billPeriodStart: new Date(data.periodStart) },
      });

      // Query generated invoices to trigger emails to residents
      const invoices = await prisma.maintenanceInvoice.findMany({
        where: { tenantId, billPeriodStart: new Date(data.periodStart), deletedAt: null },
        include: {
          flat: {
            include: {
              residents: {
                where: { deletedAt: null },
                include: { user: true }
              }
            }
          }
        }
      });

      // Trigger email notifications
      invoices.forEach((inv) => {
        const residents = inv.flat?.residents || [];
        residents.forEach((resOccupant) => {
          if (resOccupant.user?.email) {
            sendEmail(
              resOccupant.user.email,
              `📄 New Maintenance Bill: Invoice ${inv.invoiceNumber} - ₹${inv.totalAmount}`,
              getInvoiceGeneratedTemplate(
                resOccupant.user.firstName,
                inv.invoiceNumber || 'N/A',
                Number(inv.totalAmount),
                inv.dueDate.toISOString().split('T')[0],
                `${data.periodStart} to ${data.periodEnd}`
              )
            ).catch((err) => {
              console.error(`Failed to send invoice email to ${resOccupant.user.email}:`, err);
            });
          }
        });
      });

      return ApiResponse.success(
        res,
        { generatedCount: generated },
        `Invoices generated successfully via DB stored procedure. Total: ${generated}`
      );
    } catch (error) {
      next(error);
    }
  }

  // Get list of invoices (Filterable by flat, resident or status)
  static async getInvoices(req: Request, res: Response, next: NextFunction) {
    try {
      const tenantId = req.tenantId!;
      const status = req.query.status as string;

      const invoices = await prisma.maintenanceInvoice.findMany({
        where: {
          tenantId,
          deletedAt: null,
          ...(status ? { status: status as any } : {}),
        },
        include: {
          flat: {
            include: {
              wing: {
                include: {
                  building: true,
                },
              },
            },
          },
        },
        orderBy: { dueDate: 'desc' },
      });

      return ApiResponse.success(res, invoices, 'Invoices loaded successfully');
    } catch (error) {
      next(error);
    }
  }

  // Pay Maintenance Bill (Simulates payment provider UPI/Razorpay callbacks)
  static async payInvoice(req: Request, res: Response, next: NextFunction) {
    try {
      const tenantId = req.tenantId!;
      const userId = req.user!.id;
      const data = payBillSchema.parse(req.body);

      const invoice = await prisma.maintenanceInvoice.findUnique({
        where: { id: data.invoiceId, tenantId, deletedAt: null },
      });

      if (!invoice) {
        return ApiResponse.error(res, 'Invoice not found.', null, 404);
      }

      if (invoice.status === 'PAID') {
        return ApiResponse.error(res, 'Invoice is already fully paid.', null, 400);
      }

      const remainingAmount = Number(invoice.totalAmount) - Number(invoice.paidAmount);
      if (data.amount > remainingAmount) {
        return ApiResponse.error(res, `Payment amount cannot exceed remaining balance of ${remainingAmount}`, null, 400);
      }

      // Generate simulation Transaction ID
      const transactionId = `TXN-${tenantId.slice(0, 4)}-${Math.random().toString(36).substring(2, 12).toUpperCase()}`;

      // Wrap invoice updates and payment registration inside transaction
      const result = await prisma.$transaction(async (tx) => {
        const newPaidAmount = Number(invoice.paidAmount) + data.amount;
        const newStatus = newPaidAmount >= Number(invoice.totalAmount) ? 'PAID' : 'PARTIALLY_PAID';

        const updatedInvoice = await tx.maintenanceInvoice.update({
          where: { id: invoice.id },
          data: {
            paidAmount: newPaidAmount,
            status: newStatus,
          },
        });

        const payment = await tx.payment.create({
          data: {
            tenantId,
            invoiceId: invoice.id,
            userId,
            amount: data.amount,
            paymentMethod: data.paymentMethod,
            transactionId,
            paymentStatus: 'SUCCESS',
            paymentReceiptUrl: `https://saassociety.s3.amazonaws.com/receipts/${transactionId}.pdf`,
          },
        });

        return { invoice: updatedInvoice, payment };
      });

      // Send payment success confirmation email
      const payUser = req.user!;
      if (payUser && payUser.email) {
        sendEmail(
          payUser.email,
          `✅ Payment Confirmation: Invoice ${invoice.invoiceNumber} - ₹${data.amount}`,
          getPaymentSuccessTemplate(
            payUser.firstName,
            invoice.invoiceNumber || 'N/A',
            data.amount,
            result.payment.transactionId,
            result.payment.paymentReceiptUrl || ''
          )
        ).catch((err) => {
          console.error(`Failed to send payment receipt to ${payUser.email}:`, err);
        });
      }

      return ApiResponse.success(res, result, 'Payment simulated successfully. Receipt logged.', 201);
    } catch (error) {
      next(error);
    }
  }

  // Get active ledger totals (Society stats)
  static async getSocietyLedger(req: Request, res: Response, next: NextFunction) {
    try {
      const tenantId = req.tenantId!;

      const aggregateData = await prisma.maintenanceInvoice.aggregate({
        where: { tenantId, deletedAt: null },
        _sum: {
          totalAmount: true,
          paidAmount: true,
        },
      });

      const totalBilled = Number(aggregateData._sum.totalAmount || 0);
      const totalCollected = Number(aggregateData._sum.paidAmount || 0);
      const outstanding = totalBilled - totalCollected;

      return ApiResponse.success(
        res,
        {
          totalBilled,
          totalCollected,
          outstanding,
          collectionPercentage: totalBilled > 0 ? ((totalCollected / totalBilled) * 100).toFixed(2) : '0.00',
        },
        'Financial dashboard metrics loaded'
      );
    } catch (error) {
      next(error);
    }
  }
}
export default BillingController;
