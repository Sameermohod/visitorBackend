import { Router } from 'express';
import { ChargesController } from './charges.controller';
import { authenticate, checkPermission } from '../../middleware/auth';

const router = Router();

router.use(authenticate, checkPermission('charges:manage'));

/** @swagger
 * /api/v1/charges:
 *   post:
 *     summary: Issue a maintenance / function charge to every occupied flat
 */
router.post('/', ChargesController.issue);
router.get('/', ChargesController.list);
router.get('/:chargeId', ChargesController.get);
router.post('/:chargeId/remind', ChargesController.remind);
router.delete('/:chargeId', ChargesController.cancel);
router.post('/invoices/:invoiceId/record-payment', ChargesController.recordOffline);

export default router;
