import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import helmet from 'helmet';
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

const app = express();
const server = http.createServer(app);

// Initialize Socket.io
const io = new Server(server, {
  cors: {
    origin: '*', // Dynamic configurations in production
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
  },
});

const PORT = process.env.PORT || 5000;

// Apply Security and Logging
app.use(helmet());
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Logging requests using Morgan and Winston
const morganFormat = process.env.NODE_ENV === 'development' ? 'dev' : 'combined';
app.use(morgan(morganFormat, {
  stream: { write: (message) => logger.http(message.trim()) },
}));

// Apply Global Rate Limiting
const limiter = rateLimit({
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

const swaggerSpec = swaggerJsdoc(swaggerOptions);
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

// Health Route (Before Tenant Middleware)
app.get('/health', (req, res) => {
  res.json({ success: true, message: 'Platform Gateway is operational', timestamp: new Date() });
});

// Real-time Event Listener Setup
io.on('connection', (socket) => {
  logger.info(`Socket: New connection detected - ID: ${socket.id}`);

  // Dynamic Room Join by Tenant ID and User ID for targeted notifications
  socket.on('join_tenant_room', (data: { tenantId: string }) => {
    socket.join(data.tenantId);
    logger.info(`Socket: Socket ${socket.id} joined room ${data.tenantId}`);
  });

  socket.on('join_user_room', (data: { userId: string }) => {
    socket.join(data.userId);
    logger.info(`Socket: Socket ${socket.id} joined room ${data.userId}`);
  });

  socket.on('disconnect', () => {
    logger.info(`Socket: Connection terminated - ID: ${socket.id}`);
  });
});

// Expose Socket.IO globally for controllers
app.set('io', io);

// Mount Tenant Isolation Middle-ware and Master Routes
app.use('/api/v1', tenantResolver, apiRouter);

// Fallback Route
app.use('*', (req, res) => {
  res.status(404).json({ success: false, message: 'Target Route not found.' });
});

// Centralized Error Handling Middle-ware
app.use(errorHandler);

// Start server
server.listen(PORT, () => {
  logger.info(`🚀 Server running on http://localhost:${PORT}`);
  logger.info(`📖 API Docs available at http://localhost:${PORT}/api-docs`);
});
