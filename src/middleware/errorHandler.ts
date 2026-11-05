import { Request, Response, NextFunction } from 'express';
import logger from '../configs/logger';
import ApiResponse from '../utils/apiResponse';
import { ZodError } from 'zod';

export const errorHandler = (
  err: any,
  req: Request,
  res: Response,
  next: NextFunction
) => {
  logger.error(`${req.method} ${req.url} - Error: ${err.message || err}`);

  if (err instanceof ZodError) {
    const errorDetails = err.errors.map((e) => ({
      field: e.path.join('.'),
      message: e.message,
    }));
    return ApiResponse.error(res, 'Validation failed', errorDetails, 400);
  }

  // Handle standard Unauthorized or JWT Errors
  if (err.name === 'UnauthorizedError' || err.name === 'JsonWebTokenError') {
    return ApiResponse.error(res, 'Unauthorized access', null, 401);
  }

  if (err.name === 'TokenExpiredError') {
    return ApiResponse.error(res, 'Token has expired', null, 401);
  }

  // Body too large / malformed JSON are the caller's mistake, not a server fault
  if (err.type === 'entity.too.large') return ApiResponse.error(res, 'That request is too large.', null, 413);
  if (err.type === 'entity.parse.failed' || err instanceof SyntaxError) return ApiResponse.error(res, 'The request could not be read.', null, 400);

  const statusCode = err.statusCode || err.status || 500;
  // A server fault never shows its internal message (database errors, file paths) in production
  const message = statusCode >= 500 && process.env.NODE_ENV === 'production' ? 'Something went wrong on our side. Please try again.' : err.message || 'Internal Server Error';

  return ApiResponse.error(res, message, process.env.NODE_ENV === 'development' ? err.stack : null, statusCode);
};

export default errorHandler;
