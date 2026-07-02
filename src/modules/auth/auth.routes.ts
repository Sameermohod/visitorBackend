import { Router } from 'express';
import { AuthController } from './auth.controller';
import { authenticate } from '../../middleware/auth';

const router = Router();

/**
 * @swagger
 * /api/v1/auth/login:
 *   post:
 *     summary: User Login
 *     description: Returns access and refresh JWT tokens.
 */
router.post('/login', AuthController.login);

/**
 * @swagger
 * /api/v1/auth/signup:
 *   post:
 *     summary: Tenant signup Onboarding
 *     description: Creates tenant workspace, building structure and sets up Society Admin.
 */
router.post('/signup', AuthController.signup);

/**
 * @swagger
 * /api/v1/auth/refresh:
 *   post:
 *     summary: Rotate refresh token session
 */
router.post('/refresh', AuthController.refresh);

/**
 * @swagger
 * /api/v1/auth/logout:
 *   post:
 *     summary: Expire refresh session
 */
router.post('/logout', authenticate, AuthController.logout);

export default router;
