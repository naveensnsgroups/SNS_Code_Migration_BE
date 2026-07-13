import express from 'express';
import dotenv from 'dotenv';
import { Agent, setGlobalDispatcher } from 'undici';

setGlobalDispatcher(new Agent({
  headersTimeout: 0,       
  bodyTimeout: 0,          
  keepAliveTimeout: 60000, 
}));

import { corsMiddleware } from './middleware/cors.js';
import { errorHandler } from './middleware/errorHandler.js';

import { registerAllTools } from './tools/index.js';
import './agents/core/agent-definitions.js';

import scanRouter from './routes/scan.js';
import fileRouter from './routes/file.js';
import streamRouter from './routes/stream.js';
import migrateRouter from './routes/migrate.js';
import searchRouter from './routes/search.js';
import mcpRouter from './routes/mcp.js';
import configRouter from './routes/config.js';
import githubAuthRouter from './routes/github-auth.js';
import githubRouter from './routes/github.js';

dotenv.config();

registerAllTools();
console.log('[Foundation] All tools registered into ToolInvocationRegistry.');

const app = express();
const PORT = process.env.PORT || 4000;

app.use(corsMiddleware);
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

app.use('/api/scan', scanRouter);
app.use('/api/file', fileRouter);
app.use('/api/stream', streamRouter);
app.use('/api/migrate', migrateRouter);
app.use('/api/search', searchRouter);
app.use('/api/mcp', mcpRouter);
app.use('/api/config', configRouter);
app.use('/api/auth/github', githubAuthRouter);
app.use('/api/github', githubRouter);

app.get('/health', (req, res) => {
  res.json({ status: 'healthy', service: 'Code Migration Backend' });
});

app.use(errorHandler);

const server = app.listen(PORT, () => {
  console.log(`[Code Migration Backend] Server started on http://localhost:${PORT}`);
});

import { FileWatcherService } from './services/fileWatcherService.js';

async function gracefulShutdown(signal: string): Promise<void> {
  console.log(`[Server] Received ${signal} — stopping all file watchers...`);
  await FileWatcherService.stopAll();
  server.close(() => {
    console.log('[Server] HTTP server closed. Exiting.');
    process.exit(0);
  });
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
