"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getNoticePublishedTemplate = exports.getPaymentSuccessTemplate = exports.getInvoiceGeneratedTemplate = exports.getComplaintUpdateTemplate = exports.getVisitorGateAlertTemplate = exports.getStaffOnboardTemplate = exports.getResidentOnboardTemplate = exports.getAdminOnboardTemplate = exports.sendEmail = void 0;
const nodemailer_1 = __importDefault(require("nodemailer"));
const logger_1 = __importDefault(require("../configs/logger"));
// Dynamic SMTP configuration
const transporter = nodemailer_1.default.createTransport({
    host: process.env.SMTP_HOST || 'smtp.ethereal.email',
    port: Number(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_SECURE === 'true', // true for 465, false for 587/25
    auth: {
        user: process.env.SMTP_USER || 'ethereal.user@ethereal.email',
        pass: process.env.SMTP_PASS || 'ethereal-pass',
    },
});
/**
 * Global helper to send standard transactional HTML emails.
 * Degrades gracefully by logging simulated emails if SMTP credentials are the defaults or missing.
 */
const sendEmail = async (to, subject, html) => {
    try {
        const isMockSettings = !process.env.SMTP_USER ||
            process.env.SMTP_USER.includes('ethereal.user') ||
            !process.env.SMTP_PASS;
        if (isMockSettings) {
            logger_1.default.warn(`SMTP Credentials not configured. SIMULATED EMAIL DELIVERED:
=========================================
TO: ${to}
SUBJECT: ${subject}
BODY: (HTML Content omitted, logger synced)
=========================================`);
            return true;
        }
        const from = process.env.SMTP_FROM_EMAIL || 'SaaS Society <noreply@saassociety.com>';
        const info = await transporter.sendMail({
            from,
            to,
            subject,
            html,
        });
        logger_1.default.info(`SMTP: Email successfully delivered to ${to}. MessageId: ${info.messageId}`);
        return true;
    }
    catch (error) {
        logger_1.default.error(`SMTP: Failed to deliver email to ${to}:`, error);
        return false;
    }
};
exports.sendEmail = sendEmail;
/**
 * 1. welcome onboarding template for Newly registered Society Admins
 */
const getAdminOnboardTemplate = (firstName, tenantName, tenantSlug, email) => {
    return `
  <div style="font-family: sans-serif; background-color: #0f172a; color: #f8fafc; padding: 30px; border-radius: 20px; max-width: 600px; margin: 0 auto; border: 1px border-white/5;">
    <h2 style="color: #10b981; margin-bottom: 20px; text-align: center;">Welcome to SaaS Society! 🏢</h2>
    <p>Dear ${firstName},</p>
    <p>We are excited to inform you that your multi-tenant society workspace <strong>${tenantName}</strong> has been successfully registered and initialized.</p>
    <p>Below are your dynamic dashboard access parameters. Keep this details safe:</p>
    <table style="width: 100%; border-collapse: collapse; margin-top: 15px; background: rgba(255,255,255,0.05); padding: 15px; border-radius: 10px;">
      <tr><td style="padding: 10px; color: #94a3b8; border-bottom: 1px solid rgba(255,255,255,0.05);"><strong>Workspace Slug:</strong></td><td style="padding: 10px; color: #10b981; border-bottom: 1px solid rgba(255,255,255,0.05);"><strong>${tenantSlug}</strong></td></tr>
      <tr><td style="padding: 10px; color: #94a3b8; border-bottom: 1px solid rgba(255,255,255,0.05);"><strong>Admin Username:</strong></td><td style="padding: 10px; color: #f8fafc; border-bottom: 1px solid rgba(255,255,255,0.05);">${email}</td></tr>
      <tr><td style="padding: 10px; color: #94a3b8;"><strong>Setup Password:</strong></td><td style="padding: 10px; color: #f8fafc;"><em>Configured during register checkout</em></td></tr>
    </table>
    <p style="margin-top: 20px; font-size: 14px; line-height: 1.6; color: #cbd5e1;">You can onboard your residents, generate dynamic maintenance invoices via stored procedures, and setup emergency alarm workflows from your control room.</p>
    <p style="margin-top: 25px; font-size: 11px; color: #64748b; text-align: center; border-top: 1px solid rgba(255,255,255,0.05); pt: 15px;">This is a system generated email. Please do not reply.</p>
  </div>
  `;
};
exports.getAdminOnboardTemplate = getAdminOnboardTemplate;
/**
 * 2. Onboard template for Residents flat owners
 */
const getResidentOnboardTemplate = (firstName, lastName, tenantName, tenantSlug, email) => {
    return `
  <div style="font-family: sans-serif; background-color: #0f172a; color: #f8fafc; padding: 30px; border-radius: 20px; max-width: 600px; margin: 0 auto; border: 1px border-white/5;">
    <h2 style="color: #10b981; margin-bottom: 20px; text-align: center;">Welcome to Your New Home! 🔑</h2>
    <p>Dear ${firstName} ${lastName},</p>
    <p>You have been officially onboarded as a Resident occupant in <strong>${tenantName}</strong>.</p>
    <p>Your secure access profile has been created. Please log in using the temporary credentials below:</p>
    <table style="width: 100%; border-collapse: collapse; margin-top: 15px; background: rgba(255,255,255,0.05); padding: 15px; border-radius: 10px;">
      <tr><td style="padding: 10px; color: #94a3b8; border-bottom: 1px solid rgba(255,255,255,0.05);"><strong>Workspace Slug:</strong></td><td style="padding: 10px; color: #10b981; border-bottom: 1px solid rgba(255,255,255,0.05);"><strong>${tenantSlug}</strong></td></tr>
      <tr><td style="padding: 10px; color: #94a3b8; border-bottom: 1px solid rgba(255,255,255,0.05);"><strong>Access Email:</strong></td><td style="padding: 10px; color: #f8fafc; border-bottom: 1px solid rgba(255,255,255,0.05);">${email}</td></tr>
      <tr><td style="padding: 10px; color: #94a3b8;"><strong>Temporary Password:</strong></td><td style="padding: 10px; color: #f8fafc;">welcome123</td></tr>
    </table>
    <p style="margin-top: 20px; font-size: 14px; line-height: 1.6; color: #cbd5e1;">Log in to file complaints with AI categorization, download QR gate passes, and pay maintenance invoices using ourUPI sandboxes.</p>
    <p style="margin-top: 25px; font-size: 11px; color: #64748b; text-align: center; border-top: 1px solid rgba(255,255,255,0.05); pt: 15px;">SaaS Society Helpdesk & Identity System</p>
  </div>
  `;
};
exports.getResidentOnboardTemplate = getResidentOnboardTemplate;
/**
 * 3. Onboard template for service staff and guards
 */
const getStaffOnboardTemplate = (firstName, lastName, type, tenantName, tenantSlug, email) => {
    return `
  <div style="font-family: sans-serif; background-color: #0f172a; color: #f8fafc; padding: 30px; border-radius: 20px; max-width: 600px; margin: 0 auto; border: 1px border-white/5;">
    <h2 style="color: #10b981; margin-bottom: 20px; text-align: center;">Staff Profile Configured 🛠️</h2>
    <p>Hello ${firstName} ${lastName},</p>
    <p>You have been onboarded as an active staff specialist (<strong>${type}</strong>) in <strong>${tenantName}</strong>.</p>
    <p>A secure portal login profile has been successfully created for your shift operations:</p>
    <table style="width: 100%; border-collapse: collapse; margin-top: 15px; background: rgba(255,255,255,0.05); padding: 15px; border-radius: 10px;">
      <tr><td style="padding: 10px; color: #94a3b8; border-bottom: 1px solid rgba(255,255,255,0.05);"><strong>Workspace Slug:</strong></td><td style="padding: 10px; color: #10b981; border-bottom: 1px solid rgba(255,255,255,0.05);"><strong>${tenantSlug}</strong></td></tr>
      <tr><td style="padding: 10px; color: #94a3b8; border-bottom: 1px solid rgba(255,255,255,0.05);"><strong>Login Email:</strong></td><td style="padding: 10px; color: #f8fafc; border-bottom: 1px solid rgba(255,255,255,0.05);">${email}</td></tr>
      <tr><td style="padding: 10px; color: #94a3b8;"><strong>Temporary Password:</strong></td><td style="padding: 10px; color: #f8fafc;">welcome123</td></tr>
    </table>
    <p style="margin-top: 20px; font-size: 14px; line-height: 1.6; color: #cbd5e1;">You can now log in to verify guest QR gate passes, check-in visitors, or update and comment on complaints assigned to your department.</p>
    <p style="margin-top: 25px; font-size: 11px; color: #64748b; text-align: center; border-top: 1px solid rgba(255,255,255,0.05); pt: 15px;">SaaS Society Infrastructure System</p>
  </div>
  `;
};
exports.getStaffOnboardTemplate = getStaffOnboardTemplate;
/**
 * 4. Visitor gate check-in alert email to Resident flat host
 */
const getVisitorGateAlertTemplate = (visitorName, visitorType, vehicleNumber, purpose, flatNumber, checkInTime) => {
    return `
  <div style="font-family: sans-serif; background-color: #0f172a; color: #f8fafc; padding: 30px; border-radius: 20px; max-width: 600px; margin: 0 auto; border: 1px border-white/5;">
    <h2 style="color: #f43f5e; margin-bottom: 20px; text-align: center;">🚨 Gate Security Check-In Alert</h2>
    <p>Dear Resident,</p>
    <p>This is a real-time safety alert to inform you that a visitor has checked in at the main guard post to visit your flat (<strong>${flatNumber}</strong>):</p>
    <table style="width: 100%; border-collapse: collapse; margin-top: 15px; background: rgba(255,255,255,0.05); padding: 15px; border-radius: 10px;">
      <tr><td style="padding: 10px; color: #94a3b8; border-bottom: 1px solid rgba(255,255,255,0.05);"><strong>Visitor Name:</strong></td><td style="padding: 10px; color: #f8fafc; border-bottom: 1px solid rgba(255,255,255,0.05);"><strong>${visitorName}</strong></td></tr>
      <tr><td style="padding: 10px; color: #94a3b8; border-bottom: 1px solid rgba(255,255,255,0.05);"><strong>Visitor Type:</strong></td><td style="padding: 10px; color: #cbd5e1; border-bottom: 1px solid rgba(255,255,255,0.05);">${visitorType}</td></tr>
      <tr><td style="padding: 10px; color: #94a3b8; border-bottom: 1px solid rgba(255,255,255,0.05);"><strong>Vehicle Plate:</strong></td><td style="padding: 10px; color: #cbd5e1; border-bottom: 1px solid rgba(255,255,255,0.05);">${vehicleNumber || 'None'}</td></tr>
      <tr><td style="padding: 10px; color: #94a3b8; border-bottom: 1px solid rgba(255,255,255,0.05);"><strong>Stated Purpose:</strong></td><td style="padding: 10px; color: #cbd5e1; border-bottom: 1px solid rgba(255,255,255,0.05);">${purpose || 'Not stated'}</td></tr>
      <tr><td style="padding: 10px; color: #94a3b8;"><strong>Check-In Time:</strong></td><td style="padding: 10px; color: #10b981;"><strong>${checkInTime}</strong></td></tr>
    </table>
    <p style="margin-top: 20px; font-size: 14px; line-height: 1.6; color: #cbd5e1; text-align: center; background: rgba(244,63,94,0.1); padding: 10px; border-radius: 10px; border: 1px solid rgba(244,63,94,0.2);">If you did not authorize this gate pass entry, contact Main Guard checkpoint immediately.</p>
    <p style="margin-top: 25px; font-size: 11px; color: #64748b; text-align: center; border-top: 1px solid rgba(255,255,255,0.05); pt: 15px;">SaaS Society Real-time Safety Monitoring</p>
  </div>
  `;
};
exports.getVisitorGateAlertTemplate = getVisitorGateAlertTemplate;
/**
 * 5. Complaint ticket updates template
 */
const getComplaintUpdateTemplate = (recipientName, ticketNumber, title, status, category, actionText) => {
    return `
  <div style="font-family: sans-serif; background-color: #0f172a; color: #f8fafc; padding: 30px; border-radius: 20px; max-width: 600px; margin: 0 auto; border: 1px border-white/5;">
    <h2 style="color: #06b6d4; margin-bottom: 20px; text-align: center;">📝 Complaint SLA Status Update</h2>
    <p>Dear ${recipientName},</p>
    <p>There is a new operational progress update regarding the following service ticket:</p>
    <table style="width: 100%; border-collapse: collapse; margin-top: 15px; background: rgba(255,255,255,0.05); padding: 15px; border-radius: 10px;">
      <tr><td style="padding: 10px; color: #94a3b8; border-bottom: 1px solid rgba(255,255,255,0.05);"><strong>Ticket ID:</strong></td><td style="padding: 10px; color: #cbd5e1; border-bottom: 1px solid rgba(255,255,255,0.05);">${ticketNumber}</td></tr>
      <tr><td style="padding: 10px; color: #94a3b8; border-bottom: 1px solid rgba(255,255,255,0.05);"><strong>Issue Title:</strong></td><td style="padding: 10px; color: #f8fafc; border-bottom: 1px solid rgba(255,255,255,0.05);"><strong>${title}</strong></td></tr>
      <tr><td style="padding: 10px; color: #94a3b8; border-bottom: 1px solid rgba(255,255,255,0.05);"><strong>Category:</strong></td><td style="padding: 10px; color: #f8fafc; border-bottom: 1px solid rgba(255,255,255,0.05);">${category}</td></tr>
      <tr><td style="padding: 10px; color: #94a3b8; border-bottom: 1px solid rgba(255,255,255,0.05);"><strong>New Status:</strong></td><td style="padding: 10px; color: #06b6d4; border-bottom: 1px solid rgba(255,255,255,0.05);"><strong>${status}</strong></td></tr>
      <tr><td style="padding: 10px; color: #94a3b8;"><strong>Activity Update:</strong></td><td style="padding: 10px; color: #10b981;"><strong>${actionText}</strong></td></tr>
    </table>
    <p style="margin-top: 20px; font-size: 14px; line-height: 1.6; color: #cbd5e1;">You can check the full thread history or reply directly inside the dashboard Complaints panel.</p>
    <p style="margin-top: 25px; font-size: 11px; color: #64748b; text-align: center; border-top: 1px solid rgba(255,255,255,0.05); pt: 15px;">SaaS Society Helpdesk & SLA Tracker</p>
  </div>
  `;
};
exports.getComplaintUpdateTemplate = getComplaintUpdateTemplate;
/**
 * 6. New Invoice Generated Notification Template
 */
const getInvoiceGeneratedTemplate = (recipientName, invoiceNumber, amount, dueDate, billingPeriod) => {
    return `
  <div style="font-family: sans-serif; background-color: #0f172a; color: #f8fafc; padding: 30px; border-radius: 20px; max-width: 600px; margin: 0 auto; border: 1px solid rgba(255,255,255,0.05);">
    <h2 style="color: #f59e0b; margin-bottom: 20px; text-align: center;">📄 New Maintenance Invoice Raised</h2>
    <p>Dear ${recipientName},</p>
    <p>This is to inform you that a new monthly maintenance invoice has been generated for your flat:</p>
    <table style="width: 100%; border-collapse: collapse; margin-top: 15px; background: rgba(255,255,255,0.05); padding: 15px; border-radius: 10px;">
      <tr><td style="padding: 10px; color: #94a3b8; border-bottom: 1px solid rgba(255,255,255,0.05);"><strong>Invoice Number:</strong></td><td style="padding: 10px; color: #cbd5e1; border-bottom: 1px solid rgba(255,255,255,0.05); font-family: monospace;"><strong>${invoiceNumber}</strong></td></tr>
      <tr><td style="padding: 10px; color: #94a3b8; border-bottom: 1px solid rgba(255,255,255,0.05);"><strong>Billing Period:</strong></td><td style="padding: 10px; color: #f8fafc; border-bottom: 1px solid rgba(255,255,255,0.05);"><strong>${billingPeriod}</strong></td></tr>
      <tr><td style="padding: 10px; color: #94a3b8; border-bottom: 1px solid rgba(255,255,255,0.05);"><strong>Total Amount Due:</strong></td><td style="padding: 10px; color: #10b981; border-bottom: 1px solid rgba(255,255,255,0.05);"><strong>₹${amount}</strong></td></tr>
      <tr><td style="padding: 10px; color: #94a3b8;"><strong>Payment Due Date:</strong></td><td style="padding: 10px; color: #f43f5e;"><strong>${dueDate}</strong></td></tr>
    </table>
    <p style="margin-top: 20px; font-size: 14px; line-height: 1.6; color: #cbd5e1;">Please log in to your SaaS Society portal to pay this invoice online via UPI or other payment methods to avoid late fees.</p>
    <p style="margin-top: 25px; font-size: 11px; color: #64748b; text-align: center; border-top: 1px solid rgba(255,255,255,0.05); pt: 15px;">SaaS Society Billing & Accounts Dept.</p>
  </div>
  `;
};
exports.getInvoiceGeneratedTemplate = getInvoiceGeneratedTemplate;
/**
 * 7. Payment Confirmation Receipt Template
 */
const getPaymentSuccessTemplate = (recipientName, invoiceNumber, amountPaid, transactionId, receiptUrl) => {
    return `
  <div style="font-family: sans-serif; background-color: #0f172a; color: #f8fafc; padding: 30px; border-radius: 20px; max-width: 600px; margin: 0 auto; border: 1px solid rgba(255,255,255,0.05);">
    <h2 style="color: #10b981; margin-bottom: 20px; text-align: center;">✅ Payment Received - Thank You</h2>
    <p>Dear ${recipientName},</p>
    <p>Thank you for your payment. We have successfully processed your monthly maintenance payment:</p>
    <table style="width: 100%; border-collapse: collapse; margin-top: 15px; background: rgba(255,255,255,0.05); padding: 15px; border-radius: 10px;">
      <tr><td style="padding: 10px; color: #94a3b8; border-bottom: 1px solid rgba(255,255,255,0.05);"><strong>Invoice Number:</strong></td><td style="padding: 10px; color: #cbd5e1; border-bottom: 1px solid rgba(255,255,255,0.05);">${invoiceNumber}</td></tr>
      <tr><td style="padding: 10px; color: #94a3b8; border-bottom: 1px solid rgba(255,255,255,0.05);"><strong>Amount Paid:</strong></td><td style="padding: 10px; color: #10b981; border-bottom: 1px solid rgba(255,255,255,0.05);"><strong>₹${amountPaid}</strong></td></tr>
      <tr><td style="padding: 10px; color: #94a3b8; border-bottom: 1px solid rgba(255,255,255,0.05);"><strong>Transaction ID:</strong></td><td style="padding: 10px; color: #cbd5e1; border-bottom: 1px solid rgba(255,255,255,0.05); font-family: monospace;"><strong>${transactionId}</strong></td></tr>
      <tr><td style="padding: 10px; color: #94a3b8;"><strong>Payment Status:</strong></td><td style="padding: 10px; color: #10b981;"><strong>SUCCESS</strong></td></tr>
    </table>
    <p style="margin-top: 20px; font-size: 14px; line-height: 1.6; color: #cbd5e1;">You can download your digital payment receipt here: <a href="${receiptUrl}" style="color: #06b6d4; text-decoration: underline;" target="_blank">Download PDF Receipt</a></p>
    <p style="margin-top: 25px; font-size: 11px; color: #64748b; text-align: center; border-top: 1px solid rgba(255,255,255,0.05); pt: 15px;">SaaS Society Billing & Accounts Dept.</p>
  </div>
  `;
};
exports.getPaymentSuccessTemplate = getPaymentSuccessTemplate;
/**
 * 8. Notice Published Template
 */
const getNoticePublishedTemplate = (recipientName, noticeTitle, noticeContent, category, societyName) => {
    return `
  <div style="font-family: sans-serif; background-color: #0f172a; color: #f8fafc; padding: 30px; border-radius: 20px; max-width: 600px; margin: 0 auto; border: 1px solid rgba(255,255,255,0.05);">
    <h2 style="color: #06b6d4; margin-bottom: 20px; text-align: center;">📢 Notice Board Bulletin</h2>
    <p>Dear ${recipientName},</p>
    <p>A new notice has been published on the bulletin board for <strong>${societyName}</strong>:</p>
    <div style="margin-top: 15px; background: rgba(255,255,255,0.05); padding: 20px; border-radius: 10px; border-left: 4px solid #06b6d4;">
      <span style="font-size: 10px; font-weight: bold; color: #06b6d4; text-transform: uppercase; letter-spacing: 0.1em; display: block; margin-bottom: 5px;">${category}</span>
      <h3 style="color: #f8fafc; margin-top: 0; margin-bottom: 10px;">${noticeTitle}</h3>
      <p style="font-size: 13px; line-height: 1.6; color: #cbd5e1; white-space: pre-wrap; margin: 0;">${noticeContent}</p>
    </div>
    <p style="margin-top: 20px; font-size: 14px; line-height: 1.6; color: #cbd5e1;">Log in to your SaaS Society portal to view the full Notice Board history.</p>
    <p style="margin-top: 25px; font-size: 11px; color: #64748b; text-align: center; border-top: 1px solid rgba(255,255,255,0.05); pt: 15px;">SaaS Society Administration</p>
  </div>
  `;
};
exports.getNoticePublishedTemplate = getNoticePublishedTemplate;
