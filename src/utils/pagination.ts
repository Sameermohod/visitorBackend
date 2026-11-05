import { Request } from 'express';

// Optional ?limit= & ?page= query params. Responses stay plain arrays; without params the
// list is capped at `defaultLimit` rows so a growing table can't produce an unbounded payload.
export const getPagination = (req: Request, defaultLimit = 500, maxLimit = 1000) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit as string, 10) || defaultLimit, 1), maxLimit);
  const page = Math.max(parseInt(req.query.page as string, 10) || 1, 1);
  return { take: limit, skip: (page - 1) * limit };
};
