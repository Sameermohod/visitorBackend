import express from 'express';
import http from 'http';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import swaggerUi from 'swagger-ui-express';
import swaggerJsdoc from 'swagger-jsdoc';
import dotenv from 'dotenv';

// Load configs
dotenv.config();

import apiRouter from './routes';
import tenantResolver from './middleware/tenant';
import errorHandler from './middleware/errorHandler';
import logger from './configs/logger';
import { PaymentsController } from './modules/payments/payments.controller';
import { startAutopayScheduler } from './services/autopay';
import { startEscalationScheduler } from './services/escalation';
import { authenticate } from './middleware/auth';
import { responseCache } from './middleware/responseCache';
import { gatewayAuth } from './modules/cameras/cameras.controller';
import prisma from './configs/db';
import { handleMcp, rejectMcp } from './mcp/server';
import { initRealtime } from './realtime/hub';
import { assertSecrets } from './configs/secrets';
import { apiLimiter, authLimiter, corsOptions, noStore, validTenantHeaders, warnCors } from './middleware/security';

// Stop at once if a signing secret is missing in production
assertSecrets();
warnCors();

const app = express();
const server = http.createServer(app);

// Live updates (messages, notifications, "something changed" signals). Sockets sign in with the same token as the API.
initRealtime(server);

const PORT = process.env.PORT || 5000;

// Behind a reverse proxy (Render etc.) so rate limiting and logs see the real client IP
app.set('trust proxy', 1);

// Apply Security and Logging
app.disable('x-powered-by');
app.use(helmet({
  // This server only returns JSON: nothing on it should ever be framed, scripted or embedded
  contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"], baseUri: ["'none'"], formAction: ["'none'"] } },
  crossOriginResourcePolicy: { policy: 'same-site' },
  referrerPolicy: { policy: 'no-referrer' },
  hsts: { maxAge: 31536000, includeSubDomains: true },
}));
app.use(compression());
app.use(cors(corsOptions));
// Stripe signs the exact bytes it sends, so its webhook must see the raw body (before the JSON parser)
app.post(
  '/api/v1/payments/stripe/webhook/:slug',
  express.raw({ type: 'application/json', limit: '1mb' }),
  PaymentsController.webhook
);

// Requests here are small forms. A big body is either a mistake or an attack.
app.use(express.json({ limit: process.env.BODY_LIMIT || '1mb' }));
app.use(express.urlencoded({ extended: true, limit: process.env.BODY_LIMIT || '1mb' }));

// Logging requests using Morgan and Winston
const morganFormat = process.env.NODE_ENV === 'development' ? 'dev' : 'combined';
app.use(morgan(morganFormat, {
  stream: { write: (message) => logger.http(message.trim()) },
}));

// The society's camera gateway (MediaMTX) asks this before serving each video chunk. It runs before the rate limiter
// (one gateway makes many calls a second) and before the tenant check, because the viewer's token is the credential.
app.post('/api/v1/cameras/gateway-auth', gatewayAuth);

// Rate limits: a strict one for sign-in / sign-up / token refresh, a general one for everything else
app.use(['/api/v1/auth/login', '/api/v1/auth/super-login', '/api/v1/auth/signup', '/api/v1/auth/refresh'], authLimiter);
app.use('/api', apiLimiter, noStore);

// Swagger Documentation Setup
const swaggerOptions = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'SaaS Apartment and Society Management API Docs',
      version: '1.0.0',
      description: 'Comprehensive, multi-tenant API directory mapping core modules, auth systems, and gate passes.',
    },
    servers: [
      {
        url: `http://localhost:${PORT}`,
        description: 'Local Development Server',
      },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
        },
      },
    },
    security: [
      {
        bearerAuth: [],
      },
    ],
  },
  apis: ['./src/routes/*.ts', './src/modules/**/*.routes.ts'],
};

// Scanning route files to build the spec is slow, so do it on the first /api-docs hit, not at boot
// The API map is for developers: hidden in production unless ENABLE_API_DOCS=true
const docsOn = process.env.NODE_ENV !== 'production' || process.env.ENABLE_API_DOCS === 'true';
let swaggerRouter: express.Router | null = null;
app.use('/api-docs', (req, res, next) => {
  res.removeHeader('Content-Security-Policy');
  if (!docsOn) return res.status(404).json({ success: false, message: 'Target Route not found.' });
  if (!swaggerRouter) {
    swaggerRouter = express.Router();
    swaggerRouter.use(swaggerUi.serve, swaggerUi.setup(swaggerJsdoc(swaggerOptions)));
  }
  swaggerRouter(req, res, next);
});

// Health Route (Before Tenant Middleware)
app.get('/health', (req, res) => {
  res.json({ success: true, message: 'Platform Gateway is operational', timestamp: new Date() });
});

// MCP server for AI apps. Same login as the web app (a Bearer token); each person only gets the tools their role allows.
const mcpLimiter = rateLimit({ windowMs: 60 * 1000, max: 120, message: { error: 'Too many MCP requests, slow down.' } });
app.post('/mcp', mcpLimiter, authenticate, handleMcp);
app.get('/mcp', rejectMcp);
app.delete('/mcp', rejectMcp);

// Mount Tenant Isolation Middle-ware and Master Routes
app.use('/api/v1', validTenantHeaders, tenantResolver, responseCache, apiRouter);

// Fallback Route
app.use('*', (req, res) => {
  res.status(404).json({ success: false, message: 'Target Route not found.' });
});

// Centralized Error Handling Middle-ware
app.use(errorHandler);

// On Vercel the platform runs the app itself (no listening port, no background jobs, no WebSockets), so only start the server elsewhere
const serverless = !!process.env.VERCEL;
if (!serverless) server.listen(PORT, () => {
  logger.info(`🚀 Server running on http://localhost:${PORT}`);
  logger.info(`📖 API Docs available at http://localhost:${PORT}/api-docs`);
  // Open the database connection now and keep it warm: the first request after an idle spell otherwise
  // pays a slow reconnect through the pooler (1-3 seconds)
  prisma.$connect().catch((e) => logger.error('Database connection failed:', e));
  setInterval(() => prisma.$queryRaw`SELECT 1`.catch(() => undefined), 30_000).unref();

  startAutopayScheduler();
  startEscalationScheduler();
});

export default app;
