"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.BillingController = void 0;
const zod_1 = require("zod");
const db_1 = __importDefault(require("../../configs/db"));
const apiResponse_1 = __importDefault(require("../../utils/apiResponse"));
const logger_1 = __importDefault(require("../../configs/logger"));
const emailService_1 = require("../../utils/emailService");
const generateBillSchema = zod_1.z.object({
    periodStart: zod_1.z.string().regex(/^\d{4}-\d{2}-\d{2}$/), // "YYYY-MM-DD"
    periodEnd: zod_1.z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    baseAmount: zod_1.z.number().min(1),
    gstRate: zod_1.z.number().min(0).default(18.00), // Default 18% GST in India
});
const payBillSchema = zod_1.z.object({
    invoiceId: zod_1.z.string().uuid(),
    amount: zod_1.z.number().min(1),
    paymentMethod: zod_1.z.enum(['UPI', 'RAZORPAY', 'CARD', 'CASH']).default('UPI'),
});
class BillingController {
    // Generate Invoices in batch using the DB stored procedure
    static async generateMonthlyInvoices(req, res, next) {
        try {
            const tenantId = req.tenantId;
            const data = generateBillSchema.parse(req.body);
            logger_1.default.info(`Billing: Invoking DB procedure_generate_monthly_bills for tenant: ${tenantId}`);
            // Execute SQL Procedure
            await db_1.default.$executeRawUnsafe(`CALL procedure_generate_monthly_bills($1::uuid, $2::date, $3::date, $4::numeric, $5::numeric)`, tenantId, new Date(data.periodStart), new Date(data.periodEnd), data.baseAmount, data.gstRate);
            // Verify generated count
            const generated = await db_1.default.maintenanceInvoice.count({
                where: { tenantId, billPeriodStart: new Date(data.periodStart) },
            });
            // Query generated invoices to trigger emails to residents
            const invoices = await db_1.default.maintenanceInvoice.findMany({
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
                        (0, emailService_1.sendEmail)(resOccupant.user.email, `📄 New Maintenance Bill: Invoice ${inv.invoiceNumber} - ₹${inv.totalAmount}`, (0, emailService_1.getInvoiceGeneratedTemplate)(resOccupant.user.firstName, inv.invoiceNumber || 'N/A', Number(inv.totalAmount), inv.dueDate.toISOString().split('T')[0], `${data.periodStart} to ${data.periodEnd}`)).catch((err) => {
                            console.error(`Failed to send invoice email to ${resOccupant.user.email}:`, err);
                        });
                    }
                });
            });
            return apiResponse_1.default.success(res, { generatedCount: generated }, `Invoices generated successfully via DB stored procedure. Total: ${generated}`);
        }
        catch (error) {
            next(error);
        }
    }
    // Get list of invoices (Filterable by flat, resident or status)
    static async getInvoices(req, res, next) {
        try {
            const tenantId = req.tenantId;
            const status = req.query.status;
            const invoices = await db_1.default.maintenanceInvoice.findMany({
                where: {
                    tenantId,
                    deletedAt: null,
                    ...(status ? { status: status } : {}),
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
            return apiResponse_1.default.success(res, invoices, 'Invoices loaded successfully');
        }
        catch (error) {
            next(error);
        }
    }
    // Pay Maintenance Bill (Simulates payment provider UPI/Razorpay callbacks)
    static async payInvoice(req, res, next) {
        try {
            const tenantId = req.tenantId;
            const userId = req.user.id;
            const data = payBillSchema.parse(req.body);
            const invoice = await db_1.default.maintenanceInvoice.findUnique({
                where: { id: data.invoiceId, tenantId, deletedAt: null },
            });
            if (!invoice) {
                return apiResponse_1.default.error(res, 'Invoice not found.', null, 404);
            }
            if (invoice.status === 'PAID') {
                return apiResponse_1.default.error(res, 'Invoice is already fully paid.', null, 400);
            }
            const remainingAmount = Number(invoice.totalAmount) - Number(invoice.paidAmount);
            if (data.amount > remainingAmount) {
                return apiResponse_1.default.error(res, `Payment amount cannot exceed remaining balance of ${remainingAmount}`, null, 400);
            }
            // Generate simulation Transaction ID
            const transactionId = `TXN-${tenantId.slice(0, 4)}-${Math.random().toString(36).substring(2, 12).toUpperCase()}`;
            // Wrap invoice updates and payment registration inside transaction
            const result = await db_1.default.$transaction(async (tx) => {
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
            const payUser = req.user;
            if (payUser && payUser.email) {
                (0, emailService_1.sendEmail)(payUser.email, `✅ Payment Confirmation: Invoice ${invoice.invoiceNumber} - ₹${data.amount}`, (0, emailService_1.getPaymentSuccessTemplate)(payUser.firstName, invoice.invoiceNumber || 'N/A', data.amount, result.payment.transactionId, result.payment.paymentReceiptUrl || '')).catch((err) => {
                    console.error(`Failed to send payment receipt to ${payUser.email}:`, err);
                });
            }
            return apiResponse_1.default.success(res, result, 'Payment simulated successfully. Receipt logged.', 201);
        }
        catch (error) {
            next(error);
        }
    }
    // Get active ledger totals (Society stats)
    static async getSocietyLedger(req, res, next) {
        try {
            const tenantId = req.tenantId;
            const aggregateData = await db_1.default.maintenanceInvoice.aggregate({
                where: { tenantId, deletedAt: null },
                _sum: {
                    totalAmount: true,
                    paidAmount: true,
                },
            });
            const totalBilled = Number(aggregateData._sum.totalAmount || 0);
            const totalCollected = Number(aggregateData._sum.paidAmount || 0);
            const outstanding = totalBilled - totalCollected;
            return apiResponse_1.default.success(res, {
                totalBilled,
                totalCollected,
                outstanding,
                collectionPercentage: totalBilled > 0 ? ((totalCollected / totalBilled) * 100).toFixed(2) : '0.00',
            }, 'Financial dashboard metrics loaded');
        }
        catch (error) {
            next(error);
        }
    }
}
exports.BillingController = BillingController;
exports.default = BillingController;
