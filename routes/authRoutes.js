import { Router } from 'express';
import {
  login,
  register,
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

// Public endpoints
router.post('/login',       loginLimiter, login);
router.post('/register',    loginLimiter, register);   // self-registration
router.post('/seed-admin',  loginLimiter, seedAdmin);  // backward compat → same as register

// Authenticated
router.get('/me', requireAuth, me);

// User management (any logged-in user)
router.get('/users',                requireAuth, requireAdmin, listUsers);
router.post('/users',               requireAuth, requireAdmin, createUser);
router.delete('/users/:id',         requireAuth, requireAdmin, deleteUser);
router.patch('/users/:id/password', requireAuth, requireAdmin, changePassword);

export default router;
