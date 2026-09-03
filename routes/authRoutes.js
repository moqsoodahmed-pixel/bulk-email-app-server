import { Router } from 'express';
import {
  login,
  me,
  seedAdmin,
  listUsers,
  createUser,
  deleteUser,
  changePassword,
} from '../controllers/authController.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { loginLimiter } from '../middleware/rateLimiters.js';

const router = Router();

// Public
router.post('/login',      loginLimiter, login);
router.post('/seed-admin', loginLimiter, seedAdmin);

// Authenticated — any logged-in admin
router.get('/me', requireAuth, me);

// User management — admin only
router.get('/users',                   requireAuth, requireAdmin, listUsers);
router.post('/users',                  requireAuth, requireAdmin, createUser);
router.delete('/users/:id',            requireAuth, requireAdmin, deleteUser);
router.patch('/users/:id/password',    requireAuth, requireAdmin, changePassword);

export default router;