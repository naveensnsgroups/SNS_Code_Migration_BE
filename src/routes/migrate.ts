// Combines the migrate/* sub-routers under the same /api/migrate mount point
// index.ts already uses — splitting the routes into files by concern
// (session lifecycle, HITL checkpoint, Stage 2) didn't change any URL.
import { Router } from 'express';
import sessionRoutes    from './migrate/session-routes.js';
import checkpointRoutes from './migrate/checkpoint-routes.js';
import stage2Routes     from './migrate/stage2-routes.js';

const router = Router();

router.use('/', sessionRoutes);
router.use('/', checkpointRoutes);
router.use('/', stage2Routes);

export default router;
