"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const cameras_controller_1 = require("./cameras.controller");
const auth_1 = require("../../middleware/auth");
const router = (0, express_1.Router)();
router.use(auth_1.authenticate);
// Anyone signed in: the cameras they were given access to, and watching them
router.get('/', cameras_controller_1.CamerasController.list);
router.post('/:id/view', cameras_controller_1.CamerasController.view);
// Secretary and Admin: set up cameras and decide who may watch which one
router.get('/settings', (0, auth_1.checkPermission)('cameras:manage'), cameras_controller_1.CamerasController.getSettings);
router.put('/settings', (0, auth_1.checkPermission)('cameras:manage'), cameras_controller_1.CamerasController.saveSettings);
router.get('/gateway-config', (0, auth_1.checkPermission)('cameras:manage'), cameras_controller_1.CamerasController.gatewayConfig);
router.post('/', (0, auth_1.checkPermission)('cameras:manage'), cameras_controller_1.CamerasController.create);
router.patch('/:id', (0, auth_1.checkPermission)('cameras:manage'), cameras_controller_1.CamerasController.update);
router.delete('/:id', (0, auth_1.checkPermission)('cameras:manage'), cameras_controller_1.CamerasController.remove);
router.get('/:id/access', (0, auth_1.checkPermission)('cameras:manage'), cameras_controller_1.CamerasController.listAccess);
router.post('/:id/access', (0, auth_1.checkPermission)('cameras:manage'), cameras_controller_1.CamerasController.grant);
router.delete('/:id/access/:userId', (0, auth_1.checkPermission)('cameras:manage'), cameras_controller_1.CamerasController.revoke);
router.get('/:id/logs', (0, auth_1.checkPermission)('cameras:manage'), cameras_controller_1.CamerasController.logs);
exports.default = router;
