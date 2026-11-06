"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const charges_controller_1 = require("./charges.controller");
const auth_1 = require("../../middleware/auth");
const router = (0, express_1.Router)();
router.use(auth_1.authenticate, (0, auth_1.checkPermission)('charges:manage'));
/** @swagger
 * /api/v1/charges:
 *   post:
 *     summary: Issue a maintenance / function charge to every occupied flat
 */
router.post('/', charges_controller_1.ChargesController.issue);
router.get('/', charges_controller_1.ChargesController.list);
router.get('/:chargeId', charges_controller_1.ChargesController.get);
router.post('/:chargeId/remind', charges_controller_1.ChargesController.remind);
router.delete('/:chargeId', charges_controller_1.ChargesController.cancel);
router.post('/invoices/:invoiceId/record-payment', charges_controller_1.ChargesController.recordOffline);
exports.default = router;
