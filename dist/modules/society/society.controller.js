"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SocietyController = void 0;
const zod_1 = require("zod");
const db_1 = __importDefault(require("../../configs/db"));
const apiResponse_1 = __importDefault(require("../../utils/apiResponse"));
const buildingCreateSchema = zod_1.z.object({
    name: zod_1.z.string().min(1),
    wingsCount: zod_1.z.number().int().min(1).default(1),
    societyId: zod_1.z.string().uuid(),
});
const batchFlatsSchema = zod_1.z.object({
    buildingId: zod_1.z.string().uuid(),
    wingName: zod_1.z.string().min(1),
    floorsCount: zod_1.z.number().int().min(1),
    flatsPerFloor: zod_1.z.number().int().min(1),
    flatType: zod_1.z.string().default('2BHK'),
});
class SocietyController {
    // Get active society details
    static async getSociety(req, res, next) {
        try {
            const tenantId = req.tenantId;
            const society = await db_1.default.society.findFirst({
                where: { tenantId, deletedAt: null },
                include: {
                    buildings: {
                        where: { deletedAt: null },
                        include: {
                            wings: {
                                where: { deletedAt: null },
                                include: {
                                    flats: {
                                        where: { deletedAt: null },
                                    },
                                },
                            },
                        },
                    },
                },
            });
            if (!society) {
                return apiResponse_1.default.error(res, 'No society setup is configured.', null, 404);
            }
            return apiResponse_1.default.success(res, society, 'Society configurations fetched');
        }
        catch (error) {
            next(error);
        }
    }
    // Create building under tenant
    static async createBuilding(req, res, next) {
        try {
            const tenantId = req.tenantId;
            const data = buildingCreateSchema.parse(req.body);
            const building = await db_1.default.building.create({
                data: {
                    tenantId,
                    name: data.name,
                    wingsCount: data.wingsCount,
                    societyId: data.societyId,
                    createdBy: req.user?.id,
                },
            });
            return apiResponse_1.default.success(res, building, 'Building structure created successfully', 201);
        }
        catch (error) {
            next(error);
        }
    }
    // Batch Onboarding Flats under a specific Building and Wing
    static async batchGenerateFlats(req, res, next) {
        try {
            const tenantId = req.tenantId;
            const data = batchFlatsSchema.parse(req.body);
            const building = await db_1.default.building.findUnique({
                where: { id: data.buildingId, tenantId, deletedAt: null },
            });
            if (!building) {
                return apiResponse_1.default.error(res, 'Target Building does not exist.', null, 404);
            }
            // Create Wing and dynamic Flats in a database transaction
            const result = await db_1.default.$transaction(async (tx) => {
                const wing = await tx.wing.create({
                    data: {
                        tenantId,
                        buildingId: data.buildingId,
                        name: data.wingName,
                        floorsCount: data.floorsCount,
                    },
                });
                const flatsPayload = [];
                // Loop floors and units to populate flat structure
                for (let floor = 1; floor <= data.floorsCount; floor++) {
                    for (let flatNum = 1; flatNum <= data.flatsPerFloor; flatNum++) {
                        const numStr = `${floor}${flatNum.toString().padStart(2, '0')}`; // e.g. "101", "204"
                        flatsPayload.push({
                            tenantId,
                            wingId: wing.id,
                            floorNumber: floor,
                            number: `${data.wingName}-${numStr}`,
                            type: data.flatType,
                        });
                    }
                }
                // Insert flats in batch
                await tx.flat.createMany({
                    data: flatsPayload,
                });
                // Fetch inserted flats to return
                const createdFlats = await tx.flat.findMany({
                    where: { wingId: wing.id },
                });
                return { wing, flatsCount: createdFlats.length, flats: createdFlats };
            });
            return apiResponse_1.default.success(res, result, `Successfully generated Wing ${data.wingName} containing ${result.flatsCount} flats.`, 201);
        }
        catch (error) {
            next(error);
        }
    }
    // Fetch list of flats for quick dropdown selection
    static async getFlats(req, res, next) {
        try {
            const tenantId = req.tenantId;
            const flats = await db_1.default.flat.findMany({
                where: { tenantId, deletedAt: null },
                include: {
                    wing: {
                        include: {
                            building: true,
                        },
                    },
                    residents: {
                        where: { deletedAt: null },
                        include: {
                            user: true,
                        },
                    },
                },
            });
            return apiResponse_1.default.success(res, flats, 'Flats fetched successfully');
        }
        catch (error) {
            next(error);
        }
    }
    // Get active tenant settings (AI status and provider)
    static async getSettings(req, res, next) {
        try {
            const tenantId = req.tenantId;
            const tenant = await db_1.default.tenant.findUnique({
                where: { id: tenantId },
            });
            if (!tenant) {
                return apiResponse_1.default.error(res, 'Tenant workspace not found.', null, 404);
            }
            return apiResponse_1.default.success(res, {
                aiEnabled: tenant.aiEnabled,
                aiProvider: tenant.aiProvider,
                hasApiKey: !!tenant.aiApiKey,
                name: tenant.name,
                slug: tenant.slug,
            }, 'Tenant settings successfully retrieved');
        }
        catch (error) {
            next(error);
        }
    }
    // Update tenant configurations (requires tenant:settings permission)
    static async updateSettings(req, res, next) {
        try {
            const tenantId = req.tenantId;
            const settingsSchema = zod_1.z.object({
                aiEnabled: zod_1.z.boolean(),
                aiProvider: zod_1.z.enum(['GEMINI', 'OPENAI']),
                aiApiKey: zod_1.z.string().optional().nullable(),
            });
            const data = settingsSchema.parse(req.body);
            // Fetch existing tenant to check if we should keep the previous API key
            const tenant = await db_1.default.tenant.findUnique({
                where: { id: tenantId },
            });
            if (!tenant) {
                return apiResponse_1.default.error(res, 'Tenant workspace not found.', null, 404);
            }
            // Determine API key update logic (do not overwrite with empty/placeholder value)
            let updatedApiKey = tenant.aiApiKey;
            if (data.aiApiKey !== undefined && data.aiApiKey !== null && data.aiApiKey.trim() !== '') {
                const trimmed = data.aiApiKey.trim();
                const isMasked = trimmed.includes('...') || trimmed === '••••••••';
                if (!isMasked) {
                    updatedApiKey = trimmed;
                }
            }
            else if (data.aiApiKey === null || data.aiApiKey === '') {
                updatedApiKey = null;
            }
            const updatedTenant = await db_1.default.tenant.update({
                where: { id: tenantId },
                data: {
                    aiEnabled: data.aiEnabled,
                    aiProvider: data.aiProvider,
                    aiApiKey: updatedApiKey,
                },
            });
            return apiResponse_1.default.success(res, {
                aiEnabled: updatedTenant.aiEnabled,
                aiProvider: updatedTenant.aiProvider,
                hasApiKey: !!updatedTenant.aiApiKey,
            }, 'Tenant settings updated successfully');
        }
        catch (error) {
            next(error);
        }
    }
}
exports.SocietyController = SocietyController;
exports.default = SocietyController;
