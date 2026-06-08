import { Request, Response, NextFunction } from 'express';

export const errorHandler = (
  err: Error,
  req: Request,
  res: Response,
  next: NextFunction
) => {
  console.error('[Global Error Handler]:', err);

  const status = (err as any).status || 500;
  res.status(status).json({
    error: err.message || 'An unexpected error occurred',
    code: (err as any).code || 'INTERNAL_SERVER_ERROR',
  });
};
