"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.errorHandler = void 0;
const logger_1 = __importDefault(require("../configs/logger"));
const apiResponse_1 = __importDefault(require("../utils/apiResponse"));
const zod_1 = require("zod");
const errorHandler = (err, req, res, next) => {
    logger_1.default.error(`${req.method} ${req.url} - Error: ${err.message || err}`);
    if (err instanceof zod_1.ZodError) {
        const errorDetails = err.errors.map((e) => ({
            field: e.path.join('.'),
            message: e.message,
        }));
        return apiResponse_1.default.error(res, 'Validation failed', errorDetails, 400);
    }
    // Handle standard Unauthorized or JWT Errors
    if (err.name === 'UnauthorizedError' || err.name === 'JsonWebTokenError') {
        return apiResponse_1.default.error(res, 'Unauthorized access', null, 401);
    }
    if (err.name === 'TokenExpiredError') {
        return apiResponse_1.default.error(res, 'Token has expired', null, 401);
    }
    const statusCode = err.statusCode || 500;
    const message = err.message || 'Internal Server Error';
    return apiResponse_1.default.error(res, message, process.env.NODE_ENV === 'development' ? err.stack : null, statusCode);
};
exports.errorHandler = errorHandler;
exports.default = exports.errorHandler;
