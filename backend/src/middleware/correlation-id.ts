import { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';

/**
 * Middleware that reads X-Request-Id from the incoming request or generates a uuid.
 * Attaches it to req.correlationId and echoes it in the response header.
 */
export function correlationId(req: Request, res: Response, next: NextFunction): void {
  const id = (req.headers['x-request-id'] as string) || uuidv4();
  req.correlationId = id;
  res.setHeader('X-Request-Id', id);
  next();
}
