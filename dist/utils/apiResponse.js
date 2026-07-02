"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ApiResponse = void 0;
class ApiResponse {
    static success(res, data, message = 'Success', status = 200) {
        return res.status(status).json({
            success: true,
            message,
            data,
        });
    }
    static error(res, message = 'Internal Server Error', errors = null, status = 500) {
        return res.status(status).json({
            success: false,
            message,
            errors,
        });
    }
}
exports.ApiResponse = ApiResponse;
exports.default = ApiResponse;
