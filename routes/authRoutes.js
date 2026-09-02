import { Router } from 'express';
import { login, me, seedAdmin } from '../controllers/authController.js';
import { requireAuth } from '../middleware/auth.js';
import { loginLimiter } from '../middleware/rateLimiters.js';

const router = Router();

router.post('/login', loginLimiter, login);
router.post('/seed-admin', loginLimiter, seedAdmin);
router.get('/me', requireAuth, me);

export default router;
