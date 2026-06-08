import express from 'express';
import dotenv from 'dotenv';
import { corsMiddleware } from './middleware/cors.js';
import { errorHandler } from './middleware/errorHandler.js';

// Import routes
import scanRouter from './routes/scan.js';
import fileRouter from './routes/file.js';
import streamRouter from './routes/stream.js';
import migrateRouter from './routes/migrate.js';
import searchRouter from './routes/search.js';

// Initialize configuration
dotenv.config();

const app = express();
const PORT = process.env.PORT || 4000;

// Mount middlewares
app.use(corsMiddleware);
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Register routes
app.use('/api/scan', scanRouter);
app.use('/api/file', fileRouter);
app.use('/api/stream', streamRouter);
app.use('/api/migrate', migrateRouter);
app.use('/api/search', searchRouter);

// Root route for simple health check
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', service: 'Code Migration Backend' });
});

// Mount global error handler
app.use(errorHandler);

// Listen
app.listen(PORT, () => {
  console.log(`[Code Migration Backend] Server started on http://localhost:${PORT}`);
});
