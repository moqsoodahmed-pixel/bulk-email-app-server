import jwt from 'jsonwebtoken';
import User from '../models/User.js';

function signToken(user) {
  return jwt.sign(
    { sub: user._id.toString(), email: user.email, role: user.role, name: user.name },
    process.env.JWT_SECRET,
    { expiresIn: '12h' }
  );
}

// ---------------------------------------------------------------------------
// POST /api/auth/login
// ---------------------------------------------------------------------------
export async function login(req, res) {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  const user = await User.findOne({ email: email.toLowerCase().trim() });
  if (!user) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const valid = await user.comparePassword(password);
  if (!valid) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  user.lastLoginAt = new Date();
  await user.save();

  const token = signToken(user);
  res.json({ token, user: user.toJSON() });
}

// ---------------------------------------------------------------------------
// GET /api/auth/me
// ---------------------------------------------------------------------------
export async function me(req, res) {
  const user = await User.findById(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ user: user.toJSON() });
}

// ---------------------------------------------------------------------------
// GET /api/auth/users  — list all admin users (no passwords ever returned)
// ---------------------------------------------------------------------------
export async function listUsers(req, res) {
  const users = await User.find()
    .select('-passwordHash')
    .sort({ createdAt: -1 })
    .lean();
  res.json({ users });
}

// ---------------------------------------------------------------------------
// POST /api/auth/users  — create a new admin user
// Password is bcrypt-hashed (12 rounds) and stored only in MongoDB.
// Never stored in logs, env vars, or anywhere else.
// ---------------------------------------------------------------------------
export async function createUser(req, res) {
  const { name, email, password } = req.body;

  if (!name || !email || !password) {
    return res.status(400).json({ error: 'name, email, and password are required.' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Invalid email address.' });
  }

  const existing = await User.findOne({ email: email.toLowerCase().trim() });
  if (existing) {
    return res.status(409).json({ error: 'A user with that email already exists.' });
  }

  const user = new User({ name: name.trim(), email: email.toLowerCase().trim(), role: 'admin' });
  await user.setPassword(password); // bcrypt hash, 12 rounds — only write path
  await user.save();

  res.status(201).json({ user: user.toJSON(), message: `User ${email} created successfully.` });
}

// ---------------------------------------------------------------------------
// DELETE /api/auth/users/:id  — delete a user (cannot delete yourself)
// ---------------------------------------------------------------------------
export async function deleteUser(req, res) {
  if (req.params.id === req.user.id) {
    return res.status(400).json({ error: 'You cannot delete your own account.' });
  }

  const user = await User.findByIdAndDelete(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found.' });

  res.json({ message: `User ${user.email} deleted.` });
}

// ---------------------------------------------------------------------------
// PATCH /api/auth/users/:id/password  — change a user's password
// Only admins can do this. Stored as bcrypt hash, never plain text.
// ---------------------------------------------------------------------------
export async function changePassword(req, res) {
  const { password } = req.body;
  if (!password || password.length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters.' });
  }

  const user = await User.findById(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found.' });

  await user.setPassword(password);
  await user.save();

  res.json({ message: `Password updated for ${user.email}.` });
}

// ---------------------------------------------------------------------------
// POST /api/auth/seed-admin
// One-time bootstrap — disabled once any user exists.
// ---------------------------------------------------------------------------
export async function seedAdmin(req, res) {
  const existing = await User.countDocuments();
  if (existing > 0) {
    return res.status(403).json({ error: 'Admin already exists. Seeding is disabled.' });
  }

  const { name, email, password } = req.body;
  if (!name || !email || !password || password.length < 10) {
    return res
      .status(400)
      .json({ error: 'name, email, and password (min 10 chars) are required' });
  }

  const user = new User({ name, email: email.toLowerCase().trim(), role: 'admin' });
  await user.setPassword(password);
  await user.save();

  const token = signToken(user);
  res.status(201).json({ token, user: user.toJSON() });
}