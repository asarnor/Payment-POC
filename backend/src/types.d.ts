import { Request } from 'express';

declare global {
  namespace Express {
    interface Request {
      correlationId?: string;
      merchantId?: string;
    }
  }
}
