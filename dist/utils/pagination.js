"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getPagination = void 0;
// Optional ?limit= & ?page= query params. Responses stay plain arrays; without params the
// list is capped at `defaultLimit` rows so a growing table can't produce an unbounded payload.
const getPagination = (req, defaultLimit = 500, maxLimit = 1000) => {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || defaultLimit, 1), maxLimit);
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    return { take: limit, skip: (page - 1) * limit };
};
exports.getPagination = getPagination;
