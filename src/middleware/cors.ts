import cors from 'cors';

export const corsMiddleware = cors({
  origin: '*', // Allow frontend app to make requests from any origin in dev mode
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
});
