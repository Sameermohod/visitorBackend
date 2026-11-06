"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.TenancyController = void 0;
const security_1 = require("../../middleware/security");
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const zod_1 = require("zod");
const db_1 = __importDefault(require("../../configs/db"));
const apiResponse_1 = __importDefault(require("../../utils/apiResponse"));
const logger_1 = __importDefault(require("../../configs/logger"));
const emailService_1 = require("../../utils/emailService");
const auth_1 = require("../../middleware/auth");
const payments_1 = require("../../services/payments");
const tenancyAccess_1 = require("../../services/tenancyAccess");
const round2 = (n) => Math.round(n * 100) / 100;
const DEFAULT_TEMP_PASSWORD = 'welcome123';
const ymd = /^\d{4}-\d{2}-\d{2}$/;
const accessSchema = zod_1.z.object({ visitors: zod_1.z.boolean(), complaints: zod_1.z.boolean() });
const createSchema = zod_1.z.object({
    flatId: zod_1.z.string().uuid(),
    firstName: zod_1.z.string().min(1).max(100),
    lastName: zod_1.z.string().min(1).max(100),
    email: zod_1.z.string().email(),
    phoneNumber: zod_1.z.string().min(10).max(20),
    password: security_1.strongPassword.optional().or(zod_1.z.literal('')),
    startDate: zod_1.z.string().regex(ymd),
    endDate: zod_1.z.string().regex(ymd).optional().or(zod_1.z.literal('')),
    monthlyRent: zod_1.z.number().min(0).max(10_000_000),
    securityDeposit: zod_1.z.number().min(0).max(100_000_000).default(0),
    notes: zod_1.z.string().max(1000).optional(),
    access: accessSchema.optional(),
});
const updateSchema = zod_1.z.object({
    endDate: zod_1.z.string().regex(ymd).nullable().optional(),
    monthlyRent: zod_1.z.number().min(0).max(10_000_000).optional(),
    securityDeposit: zod_1.z.number().min(0).max(100_000_000).optional(),
    notes: zod_1.z.string().max(1000).nullable().optional(),
    access: accessSchema.optional(),
});
const endSchema = zod_1.z.object({
    endDate: zod_1.z.string().regex(ymd).optional(),
    reason: zod_1.z.string().max(500).optional(),
    depositReturned: zod_1.z.boolean().optional(),
});
const paymentSchema = zod_1.z.object({
    month: zod_1.z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use the format YYYY-MM.'),
    amount: zod_1.z.number().positive().max(10_000_000),
    paidOn: zod_1.z.string().regex(ymd).optional(),
    method: zod_1.z.enum(['CASH', 'BANK_TRANSFER', 'UPI', 'CHEQUE', 'OTHER']),
    reference: zod_1.z.string().max(100).optional(),
    note: zod_1.z.string().max(300).optional(),
});
/* ---------------- who may do what ---------------- */
const isOfficeManager = (req) => req.user.role === 'Super Admin' || !!req.permissions?.includes('residents:manage');
const isOfficeViewer = (req) => isOfficeManager(req) || !!req.permissions?.includes('residents:view');
/** Flats this person owns (a resident marked as OWNER). */
const ownedFlatIds = async (req) => {
    const rows = await db_1.default.resident.findMany({
        where: { tenantId: req.tenantId, userId: req.user.id, ownershipStatus: 'OWNER', deletedAt: null, flatId: { not: null } },
        select: { flatId: true },
    });
    return rows.map((r) => r.flatId);
};
const canManageFlat = async (req, flatId) => isOfficeManager(req) || (await ownedFlatIds(req)).includes(flatId);
const officeUserIds = async (tenantId) => (await db_1.default.user.findMany({
    where: { tenantId, deletedAt: null, role: { name: { in: ['Society Admin', 'Society Secretary'] } } },
    select: { id: true },
})).map((u) => u.id);
const startOfDay = (d = new Date()) => new Date(d.toISOString().slice(0, 10));
/** Month-by-month rent: what was due since the tenancy began, and what has been paid against each month. */
const buildSchedule = (t, payments) => {
    const rent = Number(t.monthlyRent);
    const last = t.endedAt && t.endedAt < new Date() ? t.endedAt : new Date();
    const months = [];
    const cursor = new Date(Date.UTC(t.startDate.getUTCFullYear(), t.startDate.getUTCMonth(), 1));
    const stop = new Date(Date.UTC(last.getUTCFullYear(), last.getUTCMonth(), 1));
    while (cursor <= stop && months.length < 60) {
        const key = cursor.toISOString().slice(0, 7);
        const paid = round2(payments.filter((p) => p.month === key).reduce((s, p) => s + Number(p.amount), 0));
        months.push({ month: key, due: rent, paid, status: paid >= rent && rent > 0 ? 'PAID' : paid > 0 ? 'PARTIAL' : 'DUE' });
        cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    }
    const expected = round2(months.length * rent);
    const collected = round2(payments.reduce((s, p) => s + Number(p.amount), 0));
    return { months, totals: { expected, collected, outstanding: Math.max(round2(expected - collected), 0) } };
};
const tenancyInclude = {
    flat: { select: { id: true, number: true, type: true, wing: { select: { name: true } } } },
    owner: { select: { id: true, firstName: true, lastName: true, phoneNumber: true } },
};
class TenancyController {
    // Flats the signed-in person owns, and whether each is currently rented out
    static async myFlats(req, res, next) {
        try {
            const flatIds = await ownedFlatIds(req);
            const flats = await db_1.default.flat.findMany({
                where: { id: { in: flatIds }, tenantId: req.tenantId, deletedAt: null },
                select: {
                    id: true, number: true, type: true, wing: { select: { name: true } },
                    tenancies: { where: { status: 'ACTIVE' }, select: { id: true }, take: 1 },
                },
                orderBy: { number: 'asc' },
            });
            return apiResponse_1.default.success(res, flats.map(({ tenancies, ...f }) => ({ ...f, activeTenancyId: tenancies[0]?.id ?? null })), 'Your flats loaded');
        }
        catch (error) {
            next(error);
        }
    }
    // Owners see the tenancies of their own flats; the society office sees all of them
    static async list(req, res, next) {
        try {
            const tenantId = req.tenantId;
            let flatFilter = {};
            if (!isOfficeViewer(req)) {
                const owned = await ownedFlatIds(req);
                if (!owned.length)
                    return apiResponse_1.default.error(res, 'Only flat owners can see tenancies.', null, 403);
                flatFilter = { flatId: { in: owned } };
            }
            const status = req.query.status;
            const tenancies = await db_1.default.tenancy.findMany({
                relationLoadStrategy: 'join',
                where: { tenantId, ...flatFilter, ...(status === 'ACTIVE' || status === 'ENDED' ? { status } : {}) },
                include: tenancyInclude,
                orderBy: [{ status: 'asc' }, { startDate: 'desc' }],
                take: 300,
            });
            const sums = tenancies.length
                ? await db_1.default.rentPayment.groupBy({ by: ['tenancyId'], where: { tenancyId: { in: tenancies.map((t) => t.id) } }, _sum: { amount: true } })
                : [];
            return apiResponse_1.default.success(res, tenancies.map((t) => ({ ...t, access: (0, tenancyAccess_1.normaliseAccess)(t.access), rentCollected: Number(sums.find((s) => s.tenancyId === t.id)?._sum.amount ?? 0) })), 'Tenancies loaded');
        }
        catch (error) {
            next(error);
        }
    }
    // One tenancy with its payments and month-by-month rent record
    static async get(req, res, next) {
        try {
            const tenancy = await db_1.default.tenancy.findFirst({
                relationLoadStrategy: 'join',
                where: { id: req.params.id, tenantId: req.tenantId },
                include: { ...tenancyInclude, payments: { orderBy: [{ paidOn: 'desc' }, { createdAt: 'desc' }] } },
            });
            if (!tenancy)
                return apiResponse_1.default.error(res, 'Tenancy not found.', null, 404);
            if (!isOfficeViewer(req) && !(await canManageFlat(req, tenancy.flatId))) {
                return apiResponse_1.default.error(res, 'You can only see tenancies of your own flats.', null, 403);
            }
            const { payments, ...rest } = tenancy;
            return apiResponse_1.default.success(res, { tenancy: { ...rest, access: (0, tenancyAccess_1.normaliseAccess)(rest.access) }, payments, ...buildSchedule(tenancy, payments) }, 'Tenancy loaded');
        }
        catch (error) {
            next(error);
        }
    }
    // Rent out a flat: creates the renter's limited login and the tenancy record
    static async create(req, res, next) {
        try {
            const tenantId = req.tenantId;
            const data = createSchema.parse(req.body);
            if (data.endDate && new Date(data.endDate) <= new Date(data.startDate)) {
                return apiResponse_1.default.error(res, 'The agreement must end after it starts.', null, 400);
            }
            const flat = await db_1.default.flat.findFirst({ where: { id: data.flatId, tenantId, deletedAt: null }, select: { id: true, number: true } });
            if (!flat)
                return apiResponse_1.default.error(res, 'Flat not found.', null, 404);
            if (!(await canManageFlat(req, flat.id))) {
                return apiResponse_1.default.error(res, 'Only the owner of this flat (or the society office) can rent it out.', null, 403);
            }
            const active = await db_1.default.tenancy.findFirst({ where: { flatId: flat.id, status: 'ACTIVE' }, select: { renterFirstName: true } });
            if (active) {
                return apiResponse_1.default.error(res, `This flat is already rented to ${active.renterFirstName}. End that tenancy first.`, null, 409);
            }
            // The landlord: the caller if they own the flat, otherwise the flat's recorded owner
            let ownerUserId = req.user.id;
            if (!(await ownedFlatIds(req)).includes(flat.id)) {
                const owner = await db_1.default.resident.findFirst({
                    where: { tenantId, flatId: flat.id, ownershipStatus: 'OWNER', deletedAt: null },
                    select: { userId: true },
                });
                if (!owner)
                    return apiResponse_1.default.error(res, 'This flat has no owner on record. Add the owner as a resident first.', null, 400);
                ownerUserId = owner.userId;
            }
            const email = data.email.trim().toLowerCase();
            if (await db_1.default.user.findFirst({ where: { email: { equals: email, mode: 'insensitive' }, tenantId, deletedAt: null }, select: { id: true } })) {
                return apiResponse_1.default.error(res, 'Someone with this email already has an account in the society.', null, 409);
            }
            const role = await db_1.default.role.findUnique({ where: { name: 'Tenant' } });
            if (!role)
                return apiResponse_1.default.error(res, 'The Tenant role is not set up yet. Run: npm run prisma:seed:rbac', null, 500);
            const tempPassword = data.password || DEFAULT_TEMP_PASSWORD;
            const passwordHash = await bcryptjs_1.default.hash(tempPassword, 10);
            const tenancy = await db_1.default.$transaction(async (tx) => {
                const user = await tx.user.create({
                    data: {
                        tenantId, email, passwordHash, firstName: data.firstName, lastName: data.lastName, phoneNumber: data.phoneNumber,
                        roleId: role.id, isVerified: true, mustChangePassword: true, createdBy: req.user.id,
                    },
                });
                await tx.resident.create({ data: { tenantId, userId: user.id, flatId: flat.id, ownershipStatus: 'TENANT' } });
                return tx.tenancy.create({
                    data: {
                        tenantId, flatId: flat.id, ownerUserId, renterUserId: user.id,
                        renterFirstName: data.firstName, renterLastName: data.lastName, renterEmail: email, renterPhone: data.phoneNumber,
                        startDate: new Date(data.startDate), endDate: data.endDate ? new Date(data.endDate) : null,
                        monthlyRent: data.monthlyRent, securityDeposit: data.securityDeposit, notes: data.notes,
                        access: { ...(data.access ?? tenancyAccess_1.DEFAULT_ACCESS) }, createdBy: req.user.id,
                    },
                    include: tenancyInclude,
                });
            });
            // Tell the office, and send the renter their login
            const society = await db_1.default.tenant.findUnique({ where: { id: tenantId }, select: { name: true, slug: true } });
            await (0, payments_1.notifyUsers)(tenantId, (await officeUserIds(tenantId)).filter((id) => id !== req.user.id), `Flat ${flat.number} rented out`, `${data.firstName} ${data.lastName} is the new tenant (${(0, payments_1.rupees)(data.monthlyRent)}/month).`, 'TENANCY');
            if (society) {
                (0, emailService_1.sendEmail)(email, `Welcome to ${society.name}: your tenant login`, (0, emailService_1.getResidentOnboardTemplate)(data.firstName, data.lastName, society.name, society.slug, email, tempPassword))
                    .catch((err) => logger_1.default.error('SMTP: Failed to send tenant welcome email:', err));
            }
            logger_1.default.info(`Tenancy: ${req.user.email} rented flat ${flat.number} to ${email}.`);
            return apiResponse_1.default.success(res, { ...tenancy, access: (0, tenancyAccess_1.normaliseAccess)(tenancy.access) }, `Flat ${flat.number} is now rented to ${data.firstName}. Their login was emailed to them.`, 201);
        }
        catch (error) {
            next(error);
        }
    }
    // Change rent, deposit, agreement end date, notes or what the renter may do
    static async update(req, res, next) {
        try {
            const data = updateSchema.parse(req.body);
            const tenancy = await db_1.default.tenancy.findFirst({ where: { id: req.params.id, tenantId: req.tenantId } });
            if (!tenancy)
                return apiResponse_1.default.error(res, 'Tenancy not found.', null, 404);
            if (!(await canManageFlat(req, tenancy.flatId)))
                return apiResponse_1.default.error(res, 'Only the flat owner or the society office can change this.', null, 403);
            if (tenancy.status !== 'ACTIVE')
                return apiResponse_1.default.error(res, 'This tenancy has ended and can no longer be changed.', null, 400);
            if (data.endDate && new Date(data.endDate) <= tenancy.startDate)
                return apiResponse_1.default.error(res, 'The agreement must end after it starts.', null, 400);
            const updated = await db_1.default.tenancy.update({
                where: { id: tenancy.id },
                data: {
                    ...(data.monthlyRent !== undefined ? { monthlyRent: data.monthlyRent } : {}),
                    ...(data.securityDeposit !== undefined ? { securityDeposit: data.securityDeposit } : {}),
                    ...(data.notes !== undefined ? { notes: data.notes } : {}),
                    ...(data.endDate !== undefined ? { endDate: data.endDate ? new Date(data.endDate) : null } : {}),
                    ...(data.access ? { access: { ...data.access } } : {}),
                },
                include: tenancyInclude,
            });
            if (tenancy.renterUserId)
                (0, tenancyAccess_1.invalidateTenantAccess)(tenancy.renterUserId); // takes effect immediately
            return apiResponse_1.default.success(res, { ...updated, access: (0, tenancyAccess_1.normaliseAccess)(updated.access) }, 'Tenancy updated.');
        }
        catch (error) {
            next(error);
        }
    }
    // The tenant moves out: their login is closed, the record stays as history
    static async end(req, res, next) {
        try {
            const tenantId = req.tenantId;
            const data = endSchema.parse(req.body ?? {});
            const tenancy = await db_1.default.tenancy.findFirst({ where: { id: req.params.id, tenantId }, include: { flat: { select: { number: true } } } });
            if (!tenancy)
                return apiResponse_1.default.error(res, 'Tenancy not found.', null, 404);
            if (!(await canManageFlat(req, tenancy.flatId)))
                return apiResponse_1.default.error(res, 'Only the flat owner or the society office can end this.', null, 403);
            if (tenancy.status !== 'ACTIVE')
                return apiResponse_1.default.error(res, 'This tenancy has already ended.', null, 400);
            const now = new Date();
            const endedAt = data.endDate ? new Date(data.endDate) : startOfDay(now);
            if (endedAt < tenancy.startDate)
                return apiResponse_1.default.error(res, 'The move-out date cannot be before the start date.', null, 400);
            await db_1.default.$transaction(async (tx) => {
                await tx.tenancy.update({
                    where: { id: tenancy.id },
                    data: { status: 'ENDED', endedAt, endReason: data.reason || null, depositReturned: data.depositReturned ?? null, endedBy: req.user.id },
                });
                if (tenancy.renterUserId) {
                    const residents = await tx.resident.findMany({ where: { tenantId, userId: tenancy.renterUserId, deletedAt: null }, select: { id: true } });
                    // Passes they made for visitors stop working, and the login is closed
                    await tx.visitor.updateMany({
                        where: { tenantId, preApprovedBy: { in: residents.map((r) => r.id) }, status: 'PRE_APPROVED', validUntil: { gt: now } },
                        data: { validUntil: now },
                    });
                    await tx.resident.updateMany({ where: { tenantId, userId: tenancy.renterUserId }, data: { deletedAt: now } });
                    await tx.user.update({ where: { id: tenancy.renterUserId }, data: { deletedAt: now, refreshToken: null } });
                }
            });
            if (tenancy.renterUserId) {
                auth_1.userCache.invalidate(tenancy.renterUserId); // the session stops working straight away
                (0, tenancyAccess_1.invalidateTenantAccess)(tenancy.renterUserId);
            }
            await (0, payments_1.notifyUsers)(tenantId, (await officeUserIds(tenantId)).filter((id) => id !== req.user.id), `Flat ${tenancy.flat.number} is vacant`, `${tenancy.renterFirstName} ${tenancy.renterLastName} has moved out.`, 'TENANCY');
            logger_1.default.info(`Tenancy: ${req.user.email} ended the tenancy of ${tenancy.renterEmail} in flat ${tenancy.flat.number}.`);
            return apiResponse_1.default.success(res, null, `${tenancy.renterFirstName}'s tenancy has ended. Their login is closed and the record is kept in the history.`);
        }
        catch (error) {
            next(error);
        }
    }
    // The owner records rent received
    static async addPayment(req, res, next) {
        try {
            const data = paymentSchema.parse(req.body);
            const tenancy = await db_1.default.tenancy.findFirst({ where: { id: req.params.id, tenantId: req.tenantId } });
            if (!tenancy)
                return apiResponse_1.default.error(res, 'Tenancy not found.', null, 404);
            if (!(await canManageFlat(req, tenancy.flatId)))
                return apiResponse_1.default.error(res, 'Only the flat owner or the society office can record rent.', null, 403);
            const payment = await db_1.default.rentPayment.create({
                data: {
                    tenantId: req.tenantId, tenancyId: tenancy.id, month: data.month, amount: data.amount,
                    paidOn: data.paidOn ? new Date(data.paidOn) : startOfDay(), method: data.method,
                    reference: data.reference, note: data.note, recordedBy: req.user.id,
                },
            });
            return apiResponse_1.default.success(res, payment, `${(0, payments_1.rupees)(data.amount)} recorded for ${data.month}.`, 201);
        }
        catch (error) {
            next(error);
        }
    }
    static async removePayment(req, res, next) {
        try {
            const payment = await db_1.default.rentPayment.findFirst({
                where: { id: req.params.paymentId, tenancyId: req.params.id, tenantId: req.tenantId },
                include: { tenancy: { select: { flatId: true } } },
            });
            if (!payment)
                return apiResponse_1.default.error(res, 'Payment not found.', null, 404);
            if (!(await canManageFlat(req, payment.tenancy.flatId)))
                return apiResponse_1.default.error(res, 'Only the flat owner or the society office can change this.', null, 403);
            await db_1.default.rentPayment.delete({ where: { id: payment.id } });
            return apiResponse_1.default.success(res, null, 'Payment removed.');
        }
        catch (error) {
            next(error);
        }
    }
}
exports.TenancyController = TenancyController;
exports.default = TenancyController;
