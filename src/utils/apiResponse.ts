import { Response } from 'express';

export class ApiResponse {
  static success(res: Response, data: any, message: string = 'Success', status: number = 200) {
    return res.status(status).json({
      success: true,
      message,
      data,
    });
  }

  static error(res: Response, message: string = 'Internal Server Error', errors: any = null, status: number = 500) {
    return res.status(status).json({
      success: false,
      message,
      errors,
    });
  }
}

export default ApiResponse;
