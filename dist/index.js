"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const http_1 = __importDefault(require("http"));
const socket_io_1 = require("socket.io");
const cors_1 = __importDefault(require("cors"));
const helmet_1 = __importDefault(require("helmet"));
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
const app = (0, express_1.default)();
const server = http_1.default.createServer(app);
// Initialize Socket.io
const io = new socket_io_1.Server(server, {
    cors: {
        origin: '*', // Dynamic configurations in production
        methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
    },
});
const PORT = process.env.PORT || 5000;
// Apply Security and Logging
app.use((0, helmet_1.default)());
app.use((0, cors_1.default)({ origin: '*' }));
app.use(express_1.default.json({ limit: '10mb' }));
app.use(express_1.default.urlencoded({ extended: true, limit: '10mb' }));
// Logging requests using Morgan and Winston
const morganFormat = process.env.NODE_ENV === 'development' ? 'dev' : 'combined';
app.use((0, morgan_1.default)(morganFormat, {
    stream: { write: (message) => logger_1.default.http(message.trim()) },
}));
// Apply Global Rate Limiting
const limiter = (0, express_rate_limit_1.default)({
    windowMs: 15 * 60 * 1000, // 15 Minutes
    max: 1000, // Limit each IP to 1000 requests per window
    message: 'Too many requests from this IP, please try again later.',
});
app.use('/api', limiter);
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
const swaggerSpec = (0, swagger_jsdoc_1.default)(swaggerOptions);
app.use('/api-docs', swagger_ui_express_1.default.serve, swagger_ui_express_1.default.setup(swaggerSpec));
// Health Route (Before Tenant Middleware)
app.get('/health', (req, res) => {
    res.json({ success: true, message: 'Platform Gateway is operational', timestamp: new Date() });
});
// Real-time Event Listener Setup
io.on('connection', (socket) => {
    logger_1.default.info(`Socket: New connection detected - ID: ${socket.id}`);
    // Dynamic Room Join by Tenant ID and User ID for targeted notifications
    socket.on('join_tenant_room', (data) => {
        socket.join(data.tenantId);
        logger_1.default.info(`Socket: Socket ${socket.id} joined room ${data.tenantId}`);
    });
    socket.on('join_user_room', (data) => {
        socket.join(data.userId);
        logger_1.default.info(`Socket: Socket ${socket.id} joined room ${data.userId}`);
    });
    socket.on('disconnect', () => {
        logger_1.default.info(`Socket: Connection terminated - ID: ${socket.id}`);
    });
});
// Expose Socket.IO globally for controllers
app.set('io', io);
// Mount Tenant Isolation Middle-ware and Master Routes
app.use('/api/v1', tenant_1.default, routes_1.default);
// Fallback Route
app.use('*', (req, res) => {
    res.status(404).json({ success: false, message: 'Target Route not found.' });
});
// Centralized Error Handling Middle-ware
app.use(errorHandler_1.default);
// Start server
server.listen(PORT, () => {
    logger_1.default.info(`🚀 Server running on http://localhost:${PORT}`);
    logger_1.default.info(`📖 API Docs available at http://localhost:${PORT}/api-docs`);
});
