import { Router } from 'express';
import { SuperAdminController } from './super-admin.controller';
import { authenticate } from '../../middleware/auth';

const router = Router();

router.use(authenticate);

router.patch('/tenants/:id/status', SuperAdminController.toggleTenantStatus);
router.delete('/tenants/:id', SuperAdminController.deleteTenant);
router.get('/data', SuperAdminController.getGlobalData);
router.delete('/users/:id', SuperAdminController.deleteUser);
router.delete('/staff/:id', SuperAdminController.deleteStaff);

export default router;
