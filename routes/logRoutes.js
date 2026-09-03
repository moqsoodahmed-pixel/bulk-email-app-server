import { Router } from 'express';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import {
  listLogs,
  getLog,
  resendFailed,
  clearFailed,
} from '../controllers/logController.js';

const router = Router();

router.use(requireAuth, requireAdmin);

router.get('/',                listLogs);
router.get('/:id',             getLog);
router.post('/:id/resend',     resendFailed);
router.delete('/:id/failed',   clearFailed);

export default router;