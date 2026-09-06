import { Router } from 'express';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { exportLeads, archiveLeads, exportAnalytics } from '../controllers/exportController.js';

const router = Router();
router.use(requireAuth, requireAdmin);

router.get('/leads',          exportLeads);      // export without deleting
router.get('/leads/archive',  archiveLeads);     // export then delete
router.get('/analytics',      exportAnalytics);  // Brevo events as Excel

export default router;
