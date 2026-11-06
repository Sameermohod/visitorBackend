"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ChargesController = void 0;
const zod_1 = require("zod");
const db_1 = __importDefault(require("../../configs/db"));
const apiResponse_1 = __importDefault(require("../../utils/apiResponse"));
const logger_1 = __importDefault(require("../../configs/logger"));
const emailService_1 = require("../../utils/emailService");
const stripe_1 = require("../../services/stripe");
const payments_1 = require("../../services/payments");
const round2 = (n) => Math.round(n * 100) / 100;
const issueSchema = zod_1.z.object({
    title: zod_1.z.string().min(3).max(150),
    kind: zod_1.z.enum(['MAINTENANCE', 'FUNCTION', 'OTHER']).default('MAINTENANCE'),
    description: zod_1.z.string().max(1000).optional().or(zod_1.z.literal('')),
    amount: zod_1.z.number().positive().max(10_000_000),
    gstRate: zod_1.z.number().min(0).max(100).default(0),
    dueDate: zod_1.z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});
const offlineSchema = zod_1.z.object({
    method: zod_1.z.enum(['CASH', 'CHEQUE', 'BANK_TRANSFER', 'UPI']),
    amount: zod_1.z.number().positive().optional(),
    reference: zod_1.z.string().max(100).optional(),
});
const dueText = (d) => d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
// Residents (users) living in the flats of a set of invoices
const residentsOfInvoices = async (tenantId, flatIds) => db_1.default.resident.findMany({ relationLoadStrategy: 'join',
    where: { tenantId, flatId: { in: flatIds }, deletedAt: null },
    select: { flatId: true, user: { select: { id: true, email: true, firstName: true } } },
});
const emailResidents = (residents, societyName, charge, amountText, due, payUrl, reminder = false) => {
    for (const r of residents) {
        if (!r.user?.email)
            continue;
        (0, emailService_1.sendEmail)(r.user.email, `${reminder ? '⏰ Reminder' : '📢 New charge'}: ${charge.title} - ${amountText}`, (0, emailService_1.getChargeNoticeTemplate)(r.user.firstName, societyName, charge.title, charge.description, amountText, dueText(due), payUrl, reminder)).catch((err) => logger_1.default.error(`SMTP: Failed to send charge email to ${r.user?.email}:`, err));
    }
};
class ChargesController {
    // Issue a charge to every occupied flat and notify each resident
    static async issue(req, res, next) {
        try {
            const tenantId = req.tenantId;
            const data = issueSchema.parse(req.body);
            const due = new Date(data.dueDate);
            const flats = await db_1.default.flat.findMany({
                where: { tenantId, deletedAt: null, residents: { some: { deletedAt: null } } },
                select: { id: true, number: true },
            });
            if (!flats.length) {
                return apiResponse_1.default.error(res, 'No occupied flats to bill yet. Add residents first.', null, 400);
            }
            const gst = round2((data.amount * data.gstRate) / 100);
            const total = round2(data.amount + gst);
            const stamp = new Date().toISOString().slice(0, 7).replace('-', '');
            const today = new Date(new Date().toISOString().slice(0, 10));
            const charge = await db_1.default.$transaction(async (tx) => {
                const created = await tx.charge.create({
                    data: {
                        tenantId,
                        title: data.title,
                        kind: data.kind,
                        description: data.description || null,
                        amount: data.amount,
                        gstRate: data.gstRate,
                        dueDate: due,
                        createdBy: req.user.id,
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
                db_1.default.tenant.findUnique({ where: { id: tenantId }, select: { name: true } }),
            ]);
            const amountText = (0, payments_1.rupees)(total);
            await (0, payments_1.notifyUsers)(tenantId, residents.map((r) => r.user.id), `New charge: ${data.title}`, `${amountText} is due by ${dueText(due)}. Open Bills to pay.`, 'CHARGE');
            emailResidents(residents, tenant?.name ?? 'Your society', charge, amountText, due, `${(0, stripe_1.appUrl)(req)}/#/billing?charge=${charge.id}`);
            logger_1.default.info(`Charges: ${req.user.email} issued "${data.title}" to ${flats.length} flats.`);
            return apiResponse_1.default.success(res, { charge, invoicesCreated: flats.length, residentsNotified: new Set(residents.map((r) => r.user.id)).size }, `Charge issued to ${flats.length} flats. Residents have been notified.`, 201);
        }
        catch (error) {
            next(error);
        }
    }
    // All issued charges with how much has been collected
    static async list(req, res, next) {
        try {
            const tenantId = req.tenantId;
            const charges = await db_1.default.charge.findMany({
                where: { tenantId, deletedAt: null },
                orderBy: { createdAt: 'desc' },
                take: 100,
            });
            const ids = charges.map((c) => c.id);
            const [totals, paid] = await Promise.all([
                db_1.default.maintenanceInvoice.groupBy({
                    by: ['chargeId'],
                    where: { tenantId, chargeId: { in: ids }, deletedAt: null },
                    _count: { _all: true },
                    _sum: { totalAmount: true, paidAmount: true },
                }),
                db_1.default.maintenanceInvoice.groupBy({
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
            return apiResponse_1.default.success(res, data, 'Charges loaded');
        }
        catch (error) {
            next(error);
        }
    }
    // One charge with its per-flat invoices
    static async get(req, res, next) {
        try {
            const tenantId = req.tenantId;
            const charge = await db_1.default.charge.findFirst({ where: { id: req.params.chargeId, tenantId, deletedAt: null } });
            if (!charge)
                return apiResponse_1.default.error(res, 'Charge not found.', null, 404);
            const invoices = await db_1.default.maintenanceInvoice.findMany({ relationLoadStrategy: 'join',
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
            return apiResponse_1.default.success(res, { charge, invoices }, 'Charge loaded');
        }
        catch (error) {
            next(error);
        }
    }
    // Admin/Secretary records a payment received outside the app (cash, cheque, bank transfer, UPI)
    static async recordOffline(req, res, next) {
        try {
            const tenantId = req.tenantId;
            const data = offlineSchema.parse(req.body);
            const invoice = await db_1.default.maintenanceInvoice.findFirst({
                where: { id: req.params.invoiceId, tenantId, deletedAt: null },
            });
            if (!invoice)
                return apiResponse_1.default.error(res, 'Invoice not found.', null, 404);
            if (invoice.status === 'PAID')
                return apiResponse_1.default.error(res, 'This invoice is already fully paid.', null, 400);
            const remaining = round2(Number(invoice.totalAmount) - Number(invoice.paidAmount));
            const amount = round2(data.amount ?? remaining);
            if (amount > remaining + 0.001) {
                return apiResponse_1.default.error(res, `Amount cannot be more than the ${(0, payments_1.rupees)(remaining)} still due.`, null, 400);
            }
            const result = await (0, payments_1.recordPayment)({
                tenantId,
                invoiceId: invoice.id,
                userId: req.user.id,
                amount,
                method: data.method,
                provider: 'MANUAL',
                reference: data.reference,
                transactionId: `MAN-${invoice.id.slice(0, 8)}-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
            });
            const residents = await residentsOfInvoices(tenantId, [invoice.flatId]);
            await (0, payments_1.notifyUsers)(tenantId, residents.map((r) => r.user.id), 'Payment received', `${(0, payments_1.rupees)(amount)} received (${data.method.replace('_', ' ').toLowerCase()}) for ${invoice.title ?? 'maintenance'}.`, 'PAYMENT');
            return apiResponse_1.default.success(res, result.invoice, 'Payment recorded.', 201);
        }
        catch (error) {
            next(error);
        }
    }
    // Remind everyone who has not paid yet
    static async remind(req, res, next) {
        try {
            const tenantId = req.tenantId;
            const charge = await db_1.default.charge.findFirst({ where: { id: req.params.chargeId, tenantId, deletedAt: null } });
            if (!charge)
                return apiResponse_1.default.error(res, 'Charge not found.', null, 404);
            const unpaid = await db_1.default.maintenanceInvoice.findMany({
                where: { chargeId: charge.id, tenantId, deletedAt: null, status: { not: 'PAID' } },
                select: { flatId: true, totalAmount: true, paidAmount: true },
            });
            if (!unpaid.length)
                return apiResponse_1.default.success(res, { reminded: 0 }, 'Everyone has already paid.');
            const [residents, tenant] = await Promise.all([
                residentsOfInvoices(tenantId, unpaid.map((i) => i.flatId)),
                db_1.default.tenant.findUnique({ where: { id: tenantId }, select: { name: true } }),
            ]);
            const total = Number(charge.amount) + (Number(charge.amount) * Number(charge.gstRate)) / 100;
            await (0, payments_1.notifyUsers)(tenantId, residents.map((r) => r.user.id), `Reminder: ${charge.title}`, `Still unpaid. Due ${dueText(charge.dueDate)}. Open Bills to pay.`, 'CHARGE');
            emailResidents(residents, tenant?.name ?? 'Your society', charge, (0, payments_1.rupees)(round2(total)), charge.dueDate, `${(0, stripe_1.appUrl)(req)}/#/billing?charge=${charge.id}`, true);
            return apiResponse_1.default.success(res, { reminded: unpaid.length }, `Reminder sent for ${unpaid.length} unpaid flats.`);
        }
        catch (error) {
            next(error);
        }
    }
    // Cancel a charge issued by mistake — only while nothing has been paid
    static async cancel(req, res, next) {
        try {
            const tenantId = req.tenantId;
            const charge = await db_1.default.charge.findFirst({ where: { id: req.params.chargeId, tenantId, deletedAt: null } });
            if (!charge)
                return apiResponse_1.default.error(res, 'Charge not found.', null, 404);
            const paid = await db_1.default.maintenanceInvoice.count({
                where: { chargeId: charge.id, tenantId, deletedAt: null, paidAmount: { gt: 0 } },
            });
            if (paid > 0) {
                return apiResponse_1.default.error(res, `${paid} flat(s) have already paid, so this charge can no longer be cancelled.`, null, 400);
            }
            const now = new Date();
            await db_1.default.$transaction([
                db_1.default.maintenanceInvoice.updateMany({ where: { chargeId: charge.id, tenantId }, data: { deletedAt: now } }),
                db_1.default.charge.update({ where: { id: charge.id }, data: { deletedAt: now } }),
            ]);
            return apiResponse_1.default.success(res, null, 'Charge cancelled.');
        }
        catch (error) {
            next(error);
        }
    }
}
exports.ChargesController = ChargesController;
exports.default = ChargesController;
