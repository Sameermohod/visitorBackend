import { Router } from 'express';
import { PaymentsController } from './payments.controller';
import { authenticate, checkPermission } from '../../middleware/auth';

// Note: the Stripe webhook is mounted separately in index.ts (it needs the raw request body)
const router = Router();

router.use(authenticate);

// Any signed-in user: is online payment available for my society?
router.get('/config', PaymentsController.config);

// Society owner (Admin) only: connect the society's own Stripe account
router.get('/stripe/settings', checkPermission('tenant:settings'), PaymentsController.getStripeSettings);
router.put('/stripe/settings', checkPermission('tenant:settings'), PaymentsController.saveStripeSettings);
router.delete('/stripe/settings', checkPermission('tenant:settings'), PaymentsController.disconnectStripe);

// Residents pay their own flat's bills
router.post('/checkout', checkPermission('billing:pay'), PaymentsController.checkout);
router.post('/confirm', checkPermission('billing:pay'), PaymentsController.confirm);

// Autopay (saved card)
router.get('/autopay', checkPermission('billing:pay'), PaymentsController.getAutopay);
router.post('/autopay/setup', checkPermission('billing:pay'), PaymentsController.setupAutopay);
router.post('/autopay/confirm', checkPermission('billing:pay'), PaymentsController.confirmAutopay);
router.delete('/autopay', checkPermission('billing:pay'), PaymentsController.disableAutopay);

export default router;
