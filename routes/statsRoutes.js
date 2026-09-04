import { Router } from 'express';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { getStats, getEvents } from '../controllers/statsController.js';

const router = Router();

router.use(requireAuth, requireAdmin);

router.get('/',       getStats);
router.get('/events', getEvents);

export default router;
