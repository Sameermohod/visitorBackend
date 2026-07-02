"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const auth_controller_1 = require("./auth.controller");
const auth_1 = require("../../middleware/auth");
const router = (0, express_1.Router)();
/**
 * @swagger
 * /api/v1/auth/login:
 *   post:
 *     summary: User Login
 *     description: Returns access and refresh JWT tokens.
 */
router.post('/login', auth_controller_1.AuthController.login);
/**
 * @swagger
 * /api/v1/auth/signup:
 *   post:
 *     summary: Tenant signup Onboarding
 *     description: Creates tenant workspace, building structure and sets up Society Admin.
 */
router.post('/signup', auth_controller_1.AuthController.signup);
/**
 * @swagger
 * /api/v1/auth/refresh:
 *   post:
 *     summary: Rotate refresh token session
 */
router.post('/refresh', auth_controller_1.AuthController.refresh);
/**
 * @swagger
 * /api/v1/auth/logout:
 *   post:
 *     summary: Expire refresh session
 */
router.post('/logout', auth_1.authenticate, auth_controller_1.AuthController.logout);
exports.default = router;
