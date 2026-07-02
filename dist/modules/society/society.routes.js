"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const society_controller_1 = require("./society.controller");
const auth_1 = require("../../middleware/auth");
const router = (0, express_1.Router)();
// Secure all endpoints with authentication
router.use(auth_1.authenticate);
/**
 * @swagger
 * /api/v1/society:
 *   get:
 *     summary: Get details of active society structure
 */
router.get('/', society_controller_1.SocietyController.getSociety);
/**
 * @swagger
 * /api/v1/society/buildings:
 *   post:
 *     summary: Add building tower
 */
router.post('/buildings', (0, auth_1.checkPermission)('society:manage'), society_controller_1.SocietyController.createBuilding);
/**
 * @swagger
 * /api/v1/society/flats/batch:
 *   post:
 *     summary: Batch onboard wing structure and flats
 */
router.post('/flats/batch', (0, auth_1.checkPermission)('society:manage'), society_controller_1.SocietyController.batchGenerateFlats);
/**
 * @swagger
 * /api/v1/society/flats:
 *   get:
 *     summary: Get simple flat lists
 */
router.get('/flats', society_controller_1.SocietyController.getFlats);
/**
 * @swagger
 * /api/v1/society/settings:
 *   get:
 *     summary: Fetch tenant custom settings
 */
router.get('/settings', society_controller_1.SocietyController.getSettings);
/**
 * @swagger
 * /api/v1/society/settings:
 *   post:
 *     summary: Update tenant custom settings
 */
router.post('/settings', (0, auth_1.checkPermission)('tenant:settings'), society_controller_1.SocietyController.updateSettings);
exports.default = router;
