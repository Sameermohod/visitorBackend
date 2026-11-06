"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const payments_controller_1 = require("./payments.controller");
const auth_1 = require("../../middleware/auth");
// Note: the Stripe webhook is mounted separately in index.ts (it needs the raw request body)
const router = (0, express_1.Router)();
router.use(auth_1.authenticate);
// Any signed-in user: is online payment available for my society?
router.get('/config', payments_controller_1.PaymentsController.config);
// Society owner (Admin) only: connect the society's own Stripe account
router.get('/stripe/settings', (0, auth_1.checkPermission)('tenant:settings'), payments_controller_1.PaymentsController.getStripeSettings);
router.put('/stripe/settings', (0, auth_1.checkPermission)('tenant:settings'), payments_controller_1.PaymentsController.saveStripeSettings);
router.delete('/stripe/settings', (0, auth_1.checkPermission)('tenant:settings'), payments_controller_1.PaymentsController.disconnectStripe);
// Residents pay their own flat's bills
router.post('/checkout', (0, auth_1.checkPermission)('billing:pay'), payments_controller_1.PaymentsController.checkout);
router.post('/confirm', (0, auth_1.checkPermission)('billing:pay'), payments_controller_1.PaymentsController.confirm);
// Autopay (saved card)
router.get('/autopay', (0, auth_1.checkPermission)('billing:pay'), payments_controller_1.PaymentsController.getAutopay);
router.post('/autopay/setup', (0, auth_1.checkPermission)('billing:pay'), payments_controller_1.PaymentsController.setupAutopay);
router.post('/autopay/confirm', (0, auth_1.checkPermission)('billing:pay'), payments_controller_1.PaymentsController.confirmAutopay);
router.delete('/autopay', (0, auth_1.checkPermission)('billing:pay'), payments_controller_1.PaymentsController.disableAutopay);
exports.default = router;
