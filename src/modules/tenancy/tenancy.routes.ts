import { Router } from 'express';
import { TenancyController } from './tenancy.controller';
import { authenticate } from '../../middleware/auth';

// Who may do what (flat owner vs society office) is decided inside the controller, flat by flat
const router = Router();
router.use(authenticate);

router.get('/my-flats', TenancyController.myFlats);
router.get('/', TenancyController.list);
router.post('/', TenancyController.create);
router.get('/:id', TenancyController.get);
router.patch('/:id', TenancyController.update);
router.post('/:id/end', TenancyController.end);
router.post('/:id/payments', TenancyController.addPayment);
router.delete('/:id/payments/:paymentId', TenancyController.removePayment);

export default router;
