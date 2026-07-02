import { Router } from 'express';
import { BillingController } from './billing.controller';
import { authenticate, checkPermission } from '../../middleware/auth';

const router = Router();

// Secure all pathways with authentication
router.use(authenticate);

/**
 * @swagger
 * /api/v1/billing/invoices:
 *   get:
 *     summary: Fetch invoices list
 */
router.get(
  '/invoices',
  checkPermission('billing:view'),
  BillingController.getInvoices
);

/**
 * @swagger
 * /api/v1/billing/generate:
 *   post:
 *     summary: Generate monthly recurring invoices via PostgreSQL CALL
 */
router.post(
  '/generate',
  checkPermission('billing:manage'),
  BillingController.generateMonthlyInvoices
);

/**
 * @swagger
 * /api/v1/billing/pay:
 *   post:
 *     summary: Process invoice payments with sandbox simulation
 */
router.post(
  '/pay',
  checkPermission('billing:pay'),
  BillingController.payInvoice
);

/**
 * @swagger
 * /api/v1/billing/ledger:
 *   get:
 *     summary: View aggregate financial summaries
 */
router.get(
  '/ledger',
  checkPermission('billing:view'),
  BillingController.getSocietyLedger
);

export default router;
