"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.VisitorController = void 0;
const zod_1 = require("zod");
const db_1 = __importDefault(require("../../configs/db"));
const apiResponse_1 = __importDefault(require("../../utils/apiResponse"));
const logger_1 = __importDefault(require("../../configs/logger"));
const emailService_1 = require("../../utils/emailService");
const preApproveSchema = zod_1.z.object({
    name: zod_1.z.string().min(1),
    phoneNumber: zod_1.z.string().min(10),
    visitorType: zod_1.z.enum(['GUEST', 'DELIVERY', 'CAB', 'SERVICE_PROVIDER']),
    vehicleNumber: zod_1.z.string().optional(),
    company: zod_1.z.string().optional(),
    purpose: zod_1.z.string().optional(),
    validFrom: zod_1.z.string().datetime(),
    validUntil: zod_1.z.string().datetime(),
});
const guardCheckInSchema = zod_1.z.object({
    visitorId: zod_1.z.string().uuid(),
    flatId: zod_1.z.preprocess((val) => (typeof val === 'string' && val.length === 36 ? val : undefined), zod_1.z.string().uuid().optional()),
    notes: zod_1.z.string().optional().default('Checked in at main gate'),
});
const faceEnrollSchema = zod_1.z.object({
    visitorName: zod_1.z.string().min(1),
    faceImageBase64: zod_1.z.string().min(100), // Enrolls base64 face vector
});
const manualEntrySchema = zod_1.z.object({
    name: zod_1.z.string().min(1),
    phoneNumber: zod_1.z.string().min(10),
    visitorType: zod_1.z.enum(['GUEST', 'DELIVERY', 'CAB']),
    company: zod_1.z.string().optional(),
    vehicleNumber: zod_1.z.string().optional(),
    flatId: zod_1.z.string().uuid(),
    purpose: zod_1.z.string().optional(),
    notes: zod_1.z.string().optional(),
});
class VisitorController {
    // Guard Walk-in Manual Entry check-in
    static async manualEntry(req, res, next) {
        try {
            const tenantId = req.tenantId;
            const guardId = req.user.id;
            const data = manualEntrySchema.parse(req.body);
            const result = await db_1.default.$transaction(async (tx) => {
                // 1. Create a Visitor record marked as APPROVED
                const visitor = await tx.visitor.create({
                    data: {
                        tenantId,
                        name: data.name,
                        phoneNumber: data.phoneNumber,
                        visitorType: data.visitorType,
                        company: data.company,
                        vehicleNumber: data.vehicleNumber,
                        purpose: data.purpose || 'Manual Entry by Guard',
                        status: 'APPROVED',
                    },
                });
                // 2. Create the VisitorLog entry immediately
                const log = await tx.visitorLog.create({
                    data: {
                        tenantId,
                        visitorId: visitor.id,
                        flatId: data.flatId,
                        checkedInBy: guardId,
                        notes: data.notes || 'Manual walk-in check-in completed at gate',
                    },
                });
                return { visitor, log };
            });
            // Fetch the full log to return to client
            const fullLog = await db_1.default.visitorLog.findUnique({
                where: { id: result.log.id },
                include: { visitor: true, flat: true },
            });
            // Asynchronously fetch occupants and notify them via SMTP email alerts
            db_1.default.resident.findMany({
                where: { flatId: data.flatId, tenantId, deletedAt: null },
                include: {
                    user: true,
                    flat: true,
                },
            }).then((flatOccupants) => {
                if (flatOccupants && flatOccupants.length > 0 && fullLog) {
                    const flatNumber = flatOccupants[0].flat?.number || 'your flat';
                    for (const occ of flatOccupants) {
                        if (occ.user && occ.user.email) {
                            (0, emailService_1.sendEmail)(occ.user.email, `🚨 Gate Security: Manual Visitor Checked In at Main Entrance`, (0, emailService_1.getVisitorGateAlertTemplate)(fullLog.visitor.name, fullLog.visitor.visitorType, fullLog.visitor.vehicleNumber, fullLog.visitor.purpose, flatNumber, new Date().toLocaleString())).catch((err) => logger_1.default.error(`SMTP: Failed to notify resident ${occ.user.email} of manual visitor check-in:`, err));
                        }
                    }
                }
            }).catch((err) => logger_1.default.error('SMTP: Failed to query flat occupants for manual visitor alert:', err));
            logger_1.default.info(`Guard: Manual visitor entry created for ${data.name} to flat ${data.flatId}`);
            return apiResponse_1.default.success(res, fullLog, 'Manual entry check-in completed successfully.', 201);
        }
        catch (error) {
            next(error);
        }
    }
    // Pre-approve guest (Resident only)
    static async preApprove(req, res, next) {
        try {
            const tenantId = req.tenantId;
            const data = preApproveSchema.parse(req.body);
            // Verify user is resident
            const resident = await db_1.default.resident.findFirst({
                where: { userId: req.user?.id, tenantId, deletedAt: null },
            });
            if (!resident) {
                return apiResponse_1.default.error(res, 'Only verified residents can pre-approve guests.', null, 403);
            }
            // Generate a dynamic, unique secure QR string token
            const qrToken = `PASS-${tenantId.slice(0, 4)}-${Math.random().toString(36).substring(2, 8).toUpperCase()}`;
            const visitor = await db_1.default.visitor.create({
                data: {
                    tenantId,
                    name: data.name,
                    phoneNumber: data.phoneNumber,
                    visitorType: data.visitorType,
                    vehicleNumber: data.vehicleNumber,
                    company: data.company,
                    purpose: data.purpose,
                    qrCode: qrToken,
                    preApprovedBy: resident.id,
                    validFrom: new Date(data.validFrom),
                    validUntil: new Date(data.validUntil),
                    status: 'PRE_APPROVED',
                },
            });
            return apiResponse_1.default.success(res, visitor, 'Guest pre-approved. QR pass generated successfully', 201);
        }
        catch (error) {
            next(error);
        }
    }
    // Get active visitor logs
    static async getLogs(req, res, next) {
        try {
            const tenantId = req.tenantId;
            const logs = await db_1.default.visitorLog.findMany({
                where: { tenantId },
                include: {
                    visitor: true,
                    flat: {
                        include: {
                            wing: {
                                include: {
                                    building: true,
                                },
                            },
                        },
                    },
                    guardIn: {
                        select: { firstName: true, lastName: true },
                    },
                },
                orderBy: { checkedInAt: 'desc' },
            });
            return apiResponse_1.default.success(res, logs, 'Visitor logs loaded successfully');
        }
        catch (error) {
            next(error);
        }
    }
    // Get active pre-approvals for Resident
    static async getMyPreApprovals(req, res, next) {
        try {
            const tenantId = req.tenantId;
            const resident = await db_1.default.resident.findFirst({
                where: { userId: req.user?.id, tenantId, deletedAt: null },
            });
            if (!resident) {
                return apiResponse_1.default.error(res, 'Resident profile not found', null, 404);
            }
            const preApprovals = await db_1.default.visitor.findMany({
                where: { tenantId, preApprovedBy: resident.id },
                orderBy: { createdAt: 'desc' },
            });
            return apiResponse_1.default.success(res, preApprovals, 'Pre-approvals loaded successfully');
        }
        catch (error) {
            next(error);
        }
    }
    // Guard QR code verification check
    static async verifyPass(req, res, next) {
        try {
            const tenantId = req.tenantId;
            let qrCode = req.query.qrCode;
            if (qrCode) {
                qrCode = qrCode.trim();
            }
            if (!qrCode) {
                return apiResponse_1.default.error(res, 'Missing QR code query parameter', null, 400);
            }
            const visitor = await db_1.default.visitor.findFirst({
                where: { tenantId, qrCode },
                include: {
                    resident: {
                        include: {
                            user: true,
                            flat: true,
                        },
                    },
                },
            });
            if (!visitor) {
                return apiResponse_1.default.error(res, 'Invalid QR code. Access denied.', null, 404);
            }
            const now = new Date();
            if (visitor.validFrom && now < visitor.validFrom) {
                return apiResponse_1.default.error(res, 'Pass is not active yet. Valid from: ' + visitor.validFrom.toISOString(), null, 400);
            }
            if (visitor.validUntil && now > visitor.validUntil) {
                return apiResponse_1.default.error(res, 'Pass has expired. Access denied.', null, 400);
            }
            return apiResponse_1.default.success(res, visitor, 'Pass is VALID. Entry ready to check-in.');
        }
        catch (error) {
            next(error);
        }
    }
    // Guard Check-in calling PostgreSQL Stored Procedure `procedure_log_visitor_entry`
    static async checkIn(req, res, next) {
        try {
            const tenantId = req.tenantId;
            const guardUserId = req.user.id;
            let { visitorId, flatId, notes } = guardCheckInSchema.parse(req.body);
            // Automatically resolve flatId from database if not provided/invalid
            if (!flatId) {
                const visitor = await db_1.default.visitor.findFirst({
                    where: { id: visitorId, tenantId },
                    include: {
                        resident: true,
                    },
                });
                if (visitor && visitor.resident && visitor.resident.flatId) {
                    flatId = visitor.resident.flatId;
                }
                else {
                    return apiResponse_1.default.error(res, 'Target resident flat details could not be resolved for this visitor. Please specify a valid flatId UUID.', null, 400);
                }
            }
            logger_1.default.info(`Visitor: Executing CALL procedure_log_visitor_entry on DB for tenant: ${tenantId}`);
            // Execute Stored Procedure
            await db_1.default.$executeRawUnsafe(`CALL procedure_log_visitor_entry($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::text, NULL::uuid)`, tenantId, visitorId, flatId, guardUserId, notes);
            // Fetch the newly logged entry to return to client
            const latestLog = await db_1.default.visitorLog.findFirst({
                where: { tenantId, visitorId, flatId },
                orderBy: { checkedInAt: 'desc' },
                include: { visitor: true, flat: true },
            });
            // Asynchronously fetch occupants and notify them via SMTP email alerts
            db_1.default.resident.findMany({
                where: { flatId, tenantId, deletedAt: null },
                include: {
                    user: true,
                    flat: true,
                },
            }).then((flatOccupants) => {
                if (flatOccupants && flatOccupants.length > 0 && latestLog) {
                    const flatNumber = flatOccupants[0].flat?.number || 'your flat';
                    for (const occ of flatOccupants) {
                        if (occ.user && occ.user.email) {
                            (0, emailService_1.sendEmail)(occ.user.email, `🚨 Gate Security: Visitor Checked In at Main Entrance`, (0, emailService_1.getVisitorGateAlertTemplate)(latestLog.visitor.name, latestLog.visitor.visitorType, latestLog.visitor.vehicleNumber, latestLog.visitor.purpose, flatNumber, new Date().toLocaleString())).catch((err) => logger_1.default.error(`SMTP: Failed to notify resident ${occ.user.email} of visitor check-in:`, err));
                        }
                    }
                }
            }).catch((err) => logger_1.default.error('SMTP: Failed to query flat occupants for visitor alert:', err));
            return apiResponse_1.default.success(res, latestLog, 'Visitor checked in successfully via stored procedure', 201);
        }
        catch (error) {
            next(error);
        }
    }
    // Check-out Visitor
    static async checkOut(req, res, next) {
        try {
            const tenantId = req.tenantId;
            const guardUserId = req.user.id;
            const logId = req.params.logId;
            const log = await db_1.default.visitorLog.findUnique({
                where: { id: logId, tenantId },
            });
            if (!log) {
                return apiResponse_1.default.error(res, 'Visitor entry log not found.', null, 404);
            }
            const result = await db_1.default.$transaction(async (tx) => {
                // Update Visitor status
                await tx.visitor.update({
                    where: { id: log.visitorId },
                    data: { status: 'DEPARTED' },
                });
                // Update Log timestamps
                return tx.visitorLog.update({
                    where: { id: logId },
                    data: {
                        checkedOutAt: new Date(),
                        checkedOutBy: guardUserId,
                    },
                    include: { visitor: true },
                });
            });
            return apiResponse_1.default.success(res, result, 'Visitor checked out successfully');
        }
        catch (error) {
            next(error);
        }
    }
    // Face Recognition visitor enrolment (Advanced Future Ready placeholder integration)
    static async enrollFace(req, res, next) {
        try {
            const tenantId = req.tenantId;
            const data = faceEnrollSchema.parse(req.body);
            // Simulation of feature vector extraction
            const faceToken = `FACE-VEC-${Math.random().toString(36).substring(2, 10).toUpperCase()}`;
            return apiResponse_1.default.success(res, {
                visitorName: data.visitorName,
                enrolledToken: faceToken,
                matchConfidence: 0.99,
                status: 'ENROLLED_SUCCESS'
            }, 'Biometric Face data enrolled successfully');
        }
        catch (error) {
            next(error);
        }
    }
    // Delete pre-approved pass (Resident only can delete their own passes)
    static async deletePass(req, res, next) {
        try {
            const tenantId = req.tenantId;
            const passId = req.params.passId;
            const userRole = req.user.role;
            const userId = req.user.id;
            if (userRole === 'Resident') {
                const resident = await db_1.default.resident.findFirst({
                    where: { userId, tenantId, deletedAt: null },
                });
                if (!resident) {
                    return apiResponse_1.default.error(res, 'Resident profile not found', null, 404);
                }
                const visitor = await db_1.default.visitor.findFirst({
                    where: { id: passId, tenantId },
                });
                if (!visitor) {
                    return apiResponse_1.default.error(res, 'Visitor pass not found', null, 404);
                }
                if (visitor.preApprovedBy !== resident.id) {
                    return apiResponse_1.default.error(res, 'Access denied: you can only delete passes created by you.', null, 403);
                }
            }
            else if (userRole !== 'Society Admin' && userRole !== 'Super Admin') {
                return apiResponse_1.default.error(res, 'Access denied: unauthorized.', null, 403);
            }
            // Delete the visitor pass
            await db_1.default.visitor.delete({
                where: { id: passId },
            });
            return apiResponse_1.default.success(res, null, 'Visitor pass deleted successfully');
        }
        catch (error) {
            next(error);
        }
    }
}
exports.VisitorController = VisitorController;
exports.default = VisitorController;
