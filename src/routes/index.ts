import { Router } from 'express';
import authRouter from '../modules/auth/auth.routes';
import societyRouter from '../modules/society/society.routes';
import residentRouter from '../modules/resident/resident.routes';
import visitorRouter from '../modules/visitor/visitor.routes';
import complaintRouter from '../modules/complaint/complaint.routes';
import billingRouter from '../modules/billing/billing.routes';
import noticeRouter from '../modules/notice/notice.routes';
import analyticsRouter from '../modules/analytics/analytics.routes';
import staffRouter from '../modules/staff/staff.routes';
import chatRouter from '../modules/chat/chat.routes';
import superAdminRouter from '../modules/super-admin/super-admin.routes';
import ApiResponse from '../utils/apiResponse';

const router = Router();

// Version 1 Health Check
router.get('/health', (req, res) => {
  return ApiResponse.success(res, { uptime: process.uptime() }, 'V1 API Server is operational');
});

// Bind modules
router.use('/auth', authRouter);
router.use('/society', societyRouter);
router.use('/residents', residentRouter);
router.use('/visitors', visitorRouter);
router.use('/complaints', complaintRouter);
router.use('/billing', billingRouter);
router.use('/notices', noticeRouter);
router.use('/analytics', analyticsRouter);
router.use('/staff', staffRouter);
router.use('/chat', chatRouter);
router.use('/super-admin', superAdminRouter);

export default router;
