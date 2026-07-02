"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const billing_controller_1 = require("./billing.controller");
const auth_1 = require("../../middleware/auth");
const router = (0, express_1.Router)();
// Secure all pathways with authentication
router.use(auth_1.authenticate);
/**
 * @swagger
 * /api/v1/billing/invoices:
 *   get:
 *     summary: Fetch invoices list
 */
router.get('/invoices', (0, auth_1.checkPermission)('billing:view'), billing_controller_1.BillingController.getInvoices);
/**
 * @swagger
 * /api/v1/billing/generate:
 *   post:
 *     summary: Generate monthly recurring invoices via PostgreSQL CALL
 */
router.post('/generate', (0, auth_1.checkPermission)('billing:manage'), billing_controller_1.BillingController.generateMonthlyInvoices);
/**
 * @swagger
 * /api/v1/billing/pay:
 *   post:
 *     summary: Process invoice payments with sandbox simulation
 */
router.post('/pay', (0, auth_1.checkPermission)('billing:pay'), billing_controller_1.BillingController.payInvoice);
/**
 * @swagger
 * /api/v1/billing/ledger:
 *   get:
 *     summary: View aggregate financial summaries
 */
router.get('/ledger', (0, auth_1.checkPermission)('billing:view'), billing_controller_1.BillingController.getSocietyLedger);
exports.default = router;
