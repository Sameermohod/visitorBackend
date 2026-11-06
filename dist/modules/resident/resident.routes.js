"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const resident_controller_1 = require("./resident.controller");
const auth_1 = require("../../middleware/auth");
const router = (0, express_1.Router)();
// Secure all pathways with authentication
router.use(auth_1.authenticate);
/**
 * @swagger
 * /api/v1/residents/directory:
 *   get:
 *     summary: Fetch society-wide resident directories
 */
router.get('/directory', (0, auth_1.checkPermission)('residents:view'), resident_controller_1.ResidentController.getDirectory);
/**
 * @swagger
 * /api/v1/residents/onboard:
 *   post:
 *     summary: Onboard and register new resident
 */
router.post('/onboard', (0, auth_1.checkPermission)('residents:manage'), resident_controller_1.ResidentController.onboard);
/**
 * @swagger
 * /api/v1/residents/{residentId}/role:
 *   patch:
 *     summary: Appoint or remove a Society Secretary
 */
router.patch('/:residentId/role', (0, auth_1.checkPermission)('users:edit'), resident_controller_1.ResidentController.changeRole);
exports.default = router;
