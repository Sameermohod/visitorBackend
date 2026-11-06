"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const http_1 = __importDefault(require("http"));
const cors_1 = __importDefault(require("cors"));
const helmet_1 = __importDefault(require("helmet"));
const compression_1 = __importDefault(require("compression"));
const morgan_1 = __importDefault(require("morgan"));
const express_rate_limit_1 = __importDefault(require("express-rate-limit"));
const swagger_ui_express_1 = __importDefault(require("swagger-ui-express"));
const swagger_jsdoc_1 = __importDefault(require("swagger-jsdoc"));
const dotenv_1 = __importDefault(require("dotenv"));
// Load configs
dotenv_1.default.config();
const routes_1 = __importDefault(require("./routes"));
const tenant_1 = __importDefault(require("./middleware/tenant"));
const errorHandler_1 = __importDefault(require("./middleware/errorHandler"));
const logger_1 = __importDefault(require("./configs/logger"));
const payments_controller_1 = require("./modules/payments/payments.controller");
const autopay_1 = require("./services/autopay");
const escalation_1 = require("./services/escalation");
const auth_1 = require("./middleware/auth");
const responseCache_1 = require("./middleware/responseCache");
const cameras_controller_1 = require("./modules/cameras/cameras.controller");
const db_1 = __importDefault(require("./configs/db"));
const server_1 = require("./mcp/server");
const hub_1 = require("./realtime/hub");
const secrets_1 = require("./configs/secrets");
const security_1 = require("./middleware/security");
// Stop at once if a signing secret is missing in production
(0, secrets_1.assertSecrets)();
(0, security_1.warnCors)();
const app = (0, express_1.default)();
const server = http_1.default.createServer(app);
// Live updates (messages, notifications, "something changed" signals). Sockets sign in with the same token as the API.
(0, hub_1.initRealtime)(server);
const PORT = process.env.PORT || 5000;
// Behind a reverse proxy (Render etc.) so rate limiting and logs see the real client IP
app.set('trust proxy', 1);
// Apply Security and Logging
app.disable('x-powered-by');
app.use((0, helmet_1.default)({
    // This server only returns JSON: nothing on it should ever be framed, scripted or embedded
    contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"], baseUri: ["'none'"], formAction: ["'none'"] } },
    crossOriginResourcePolicy: { policy: 'same-site' },
    referrerPolicy: { policy: 'no-referrer' },
    hsts: { maxAge: 31536000, includeSubDomains: true },
}));
app.use((0, compression_1.default)());
app.use((0, cors_1.default)(security_1.corsOptions));
// Stripe signs the exact bytes it sends, so its webhook must see the raw body (before the JSON parser)
app.post('/api/v1/payments/stripe/webhook/:slug', express_1.default.raw({ type: 'application/json', limit: '1mb' }), payments_controller_1.PaymentsController.webhook);
// Requests here are small forms. A big body is either a mistake or an attack.
app.use(express_1.default.json({ limit: process.env.BODY_LIMIT || '1mb' }));
app.use(express_1.default.urlencoded({ extended: true, limit: process.env.BODY_LIMIT || '1mb' }));
// Logging requests using Morgan and Winston
const morganFormat = process.env.NODE_ENV === 'development' ? 'dev' : 'combined';
app.use((0, morgan_1.default)(morganFormat, {
    stream: { write: (message) => logger_1.default.http(message.trim()) },
}));
// The society's camera gateway (MediaMTX) asks this before serving each video chunk. It runs before the rate limiter
// (one gateway makes many calls a second) and before the tenant check, because the viewer's token is the credential.
app.post('/api/v1/cameras/gateway-auth', cameras_controller_1.gatewayAuth);
// Rate limits: a strict one for sign-in / sign-up / token refresh, a general one for everything else
app.use(['/api/v1/auth/login', '/api/v1/auth/super-login', '/api/v1/auth/signup', '/api/v1/auth/refresh'], security_1.authLimiter);
app.use('/api', security_1.apiLimiter, security_1.noStore);
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
let swaggerRouter = null;
app.use('/api-docs', (req, res, next) => {
    res.removeHeader('Content-Security-Policy');
    if (!docsOn)
        return res.status(404).json({ success: false, message: 'Target Route not found.' });
    if (!swaggerRouter) {
        swaggerRouter = express_1.default.Router();
        swaggerRouter.use(swagger_ui_express_1.default.serve, swagger_ui_express_1.default.setup((0, swagger_jsdoc_1.default)(swaggerOptions)));
    }
    swaggerRouter(req, res, next);
});
// Health Route (Before Tenant Middleware)
app.get('/health', (req, res) => {
    res.json({ success: true, message: 'Platform Gateway is operational', timestamp: new Date() });
});
// MCP server for AI apps. Same login as the web app (a Bearer token); each person only gets the tools their role allows.
const mcpLimiter = (0, express_rate_limit_1.default)({ windowMs: 60 * 1000, max: 120, message: { error: 'Too many MCP requests, slow down.' } });
app.post('/mcp', mcpLimiter, auth_1.authenticate, server_1.handleMcp);
app.get('/mcp', server_1.rejectMcp);
app.delete('/mcp', server_1.rejectMcp);
// Mount Tenant Isolation Middle-ware and Master Routes
app.use('/api/v1', security_1.validTenantHeaders, tenant_1.default, responseCache_1.responseCache, routes_1.default);
// Fallback Route
app.use('*', (req, res) => {
    res.status(404).json({ success: false, message: 'Target Route not found.' });
});
// Centralized Error Handling Middle-ware
app.use(errorHandler_1.default);
// On Vercel the platform runs the app itself (no listening port, no background jobs, no WebSockets), so only start the server elsewhere
const serverless = !!process.env.VERCEL;
if (!serverless)
    server.listen(PORT, () => {
        logger_1.default.info(`🚀 Server running on http://localhost:${PORT}`);
        logger_1.default.info(`📖 API Docs available at http://localhost:${PORT}/api-docs`);
        // Open the database connection now and keep it warm: the first request after an idle spell otherwise
        // pays a slow reconnect through the pooler (1-3 seconds)
        db_1.default.$connect().catch((e) => logger_1.default.error('Database connection failed:', e));
        setInterval(() => db_1.default.$queryRaw `SELECT 1`.catch(() => undefined), 30_000).unref();
        (0, autopay_1.startAutopayScheduler)();
        (0, escalation_1.startEscalationScheduler)();
    });
exports.default = app;
