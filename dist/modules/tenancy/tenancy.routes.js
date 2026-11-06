"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const tenancy_controller_1 = require("./tenancy.controller");
const auth_1 = require("../../middleware/auth");
// Who may do what (flat owner vs society office) is decided inside the controller, flat by flat
const router = (0, express_1.Router)();
router.use(auth_1.authenticate);
router.get('/my-flats', tenancy_controller_1.TenancyController.myFlats);
router.get('/', tenancy_controller_1.TenancyController.list);
router.post('/', tenancy_controller_1.TenancyController.create);
router.get('/:id', tenancy_controller_1.TenancyController.get);
router.patch('/:id', tenancy_controller_1.TenancyController.update);
router.post('/:id/end', tenancy_controller_1.TenancyController.end);
router.post('/:id/payments', tenancy_controller_1.TenancyController.addPayment);
router.delete('/:id/payments/:paymentId', tenancy_controller_1.TenancyController.removePayment);
exports.default = router;
