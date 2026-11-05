import { Router } from 'express';
import { CamerasController } from './cameras.controller';
import { authenticate, checkPermission } from '../../middleware/auth';

const router = Router();
router.use(authenticate);

// Anyone signed in: the cameras they were given access to, and watching them
router.get('/', CamerasController.list);
router.post('/:id/view', CamerasController.view);

// Secretary and Admin: set up cameras and decide who may watch which one
router.get('/settings', checkPermission('cameras:manage'), CamerasController.getSettings);
router.put('/settings', checkPermission('cameras:manage'), CamerasController.saveSettings);
router.get('/gateway-config', checkPermission('cameras:manage'), CamerasController.gatewayConfig);
router.post('/', checkPermission('cameras:manage'), CamerasController.create);
router.patch('/:id', checkPermission('cameras:manage'), CamerasController.update);
router.delete('/:id', checkPermission('cameras:manage'), CamerasController.remove);
router.get('/:id/access', checkPermission('cameras:manage'), CamerasController.listAccess);
router.post('/:id/access', checkPermission('cameras:manage'), CamerasController.grant);
router.delete('/:id/access/:userId', checkPermission('cameras:manage'), CamerasController.revoke);
router.get('/:id/logs', checkPermission('cameras:manage'), CamerasController.logs);

export default router;
