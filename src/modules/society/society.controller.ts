import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import prisma from '../../configs/db';
import ApiResponse from '../../utils/apiResponse';

const buildingCreateSchema = z.object({
  name: z.string().min(1),
  wingsCount: z.number().int().min(1).default(1),
  societyId: z.string().uuid(),
});

const batchFlatsSchema = z.object({
  buildingId: z.string().uuid(),
  wingName: z.string().min(1),
  floorsCount: z.number().int().min(1),
  flatsPerFloor: z.number().int().min(1),
  flatType: z.string().default('2BHK'),
});

export class SocietyController {
  // Get active society details
  static async getSociety(req: Request, res: Response, next: NextFunction) {
    try {
      const tenantId = req.tenantId!;

      const society = await prisma.society.findFirst({
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
        return ApiResponse.error(res, 'No society setup is configured.', null, 404);
      }

      return ApiResponse.success(res, society, 'Society configurations fetched');
    } catch (error) {
      next(error);
    }
  }

  // Create building under tenant
  static async createBuilding(req: Request, res: Response, next: NextFunction) {
    try {
      const tenantId = req.tenantId!;
      const data = buildingCreateSchema.parse(req.body);

      const building = await prisma.building.create({
        data: {
          tenantId,
          name: data.name,
          wingsCount: data.wingsCount,
          societyId: data.societyId,
          createdBy: req.user?.id,
        },
      });

      return ApiResponse.success(res, building, 'Building structure created successfully', 201);
    } catch (error) {
      next(error);
    }
  }

  // Batch Onboarding Flats under a specific Building and Wing
  static async batchGenerateFlats(req: Request, res: Response, next: NextFunction) {
    try {
      const tenantId = req.tenantId!;
      const data = batchFlatsSchema.parse(req.body);

      const building = await prisma.building.findUnique({
        where: { id: data.buildingId, tenantId, deletedAt: null },
      });

      if (!building) {
        return ApiResponse.error(res, 'Target Building does not exist.', null, 404);
      }

      // Create Wing and dynamic Flats in a database transaction
      const result = await prisma.$transaction(async (tx) => {
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

      return ApiResponse.success(
        res,
        result,
        `Successfully generated Wing ${data.wingName} containing ${result.flatsCount} flats.`,
        201
      );
    } catch (error) {
      next(error);
    }
  }

  // Fetch list of flats for quick dropdown selection
  static async getFlats(req: Request, res: Response, next: NextFunction) {
    try {
      const tenantId = req.tenantId!;
      const flats = await prisma.flat.findMany({
        where: { tenantId, deletedAt: null },
        include: {
          wing: {
            include: {
              building: true,
            },
          },
        },
      });

      return ApiResponse.success(res, flats, 'Flats fetched successfully');
    } catch (error) {
      next(error);
    }
  }

  // Get active tenant settings (AI status and provider)
  static async getSettings(req: Request, res: Response, next: NextFunction) {
    try {
      const tenantId = req.tenantId!;

      const tenant = await prisma.tenant.findUnique({
        where: { id: tenantId },
      });

      if (!tenant) {
        return ApiResponse.error(res, 'Tenant workspace not found.', null, 404);
      }

      return ApiResponse.success(res, {
        aiEnabled: tenant.aiEnabled,
        aiProvider: tenant.aiProvider,
        hasApiKey: !!tenant.aiApiKey,
        name: tenant.name,
        slug: tenant.slug,
      }, 'Tenant settings successfully retrieved');
    } catch (error) {
      next(error);
    }
  }

  // Update tenant configurations (requires tenant:settings permission)
  static async updateSettings(req: Request, res: Response, next: NextFunction) {
    try {
      const tenantId = req.tenantId!;
      const settingsSchema = z.object({
        aiEnabled: z.boolean(),
        aiProvider: z.enum(['GEMINI', 'OPENAI']),
        aiApiKey: z.string().optional().nullable(),
      });

      const data = settingsSchema.parse(req.body);

      // Fetch existing tenant to check if we should keep the previous API key
      const tenant = await prisma.tenant.findUnique({
        where: { id: tenantId },
      });

      if (!tenant) {
        return ApiResponse.error(res, 'Tenant workspace not found.', null, 404);
      }

      // Determine API key update logic (do not overwrite with empty/placeholder value)
      let updatedApiKey = tenant.aiApiKey;
      if (data.aiApiKey !== undefined && data.aiApiKey !== null && data.aiApiKey.trim() !== '') {
        const trimmed = data.aiApiKey.trim();
        const isMasked = trimmed.includes('...') || trimmed === '••••••••';
        if (!isMasked) {
          updatedApiKey = trimmed;
        }
      } else if (data.aiApiKey === null || data.aiApiKey === '') {
        updatedApiKey = null;
      }

      const updatedTenant = await prisma.tenant.update({
        where: { id: tenantId },
        data: {
          aiEnabled: data.aiEnabled,
          aiProvider: data.aiProvider,
          aiApiKey: updatedApiKey,
        },
      });

      return ApiResponse.success(res, {
        aiEnabled: updatedTenant.aiEnabled,
        aiProvider: updatedTenant.aiProvider,
        hasApiKey: !!updatedTenant.aiApiKey,
      }, 'Tenant settings updated successfully');
    } catch (error) {
      next(error);
    }
  }
}
export default SocietyController;
