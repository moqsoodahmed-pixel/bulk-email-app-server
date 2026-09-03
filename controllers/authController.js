import jwt from 'jsonwebtoken';
import User from '../models/User.js';

function signToken(user) {
  return jwt.sign(
    { sub: user._id.toString(), email: user.email, role: user.role, name: user.name, username: user.username },
    process.env.JWT_SECRET,
    { expiresIn: '12h' }
  );
}

// Build a unique username from a display name (e.g. "Sneha Sharma" → "sneha_sharma")
function buildUsername(name, suffix = '') {
  const base = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 20);
  return suffix ? `${base}_${suffix}` : base;
}

// ---------------------------------------------------------------------------
// POST /api/auth/login
// Accepts email OR username in the identifier field.
// ---------------------------------------------------------------------------
export async function login(req, res) {
  const { identifier, email, password } = req.body;
  // Support both: { identifier, password } and legacy { email, password }
  const raw = (identifier || email || '').toLowerCase().trim();
  if (!raw || !password) {
    return res.status(400).json({ error: 'Username/email and password are required.' });
  }

  // Try email first, then username
  const isEmail = raw.includes('@');
  const user    = isEmail
    ? await User.findOne({ email: raw })
    : await User.findOne({ username: raw });

  if (!user) {
    return res.status(401).json({ error: 'Invalid credentials.' });
  }

  const valid = await user.comparePassword(password);
  if (!valid) {
    return res.status(401).json({ error: 'Invalid credentials.' });
  }

  user.lastLoginAt = new Date();
  await user.save();

  res.json({ token: signToken(user), user: user.toJSON() });
}

// ---------------------------------------------------------------------------
// GET /api/auth/me
// ---------------------------------------------------------------------------
export async function me(req, res) {
  const user = await User.findById(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  res.json({ user: user.toJSON() });
}

// ---------------------------------------------------------------------------
// GET /api/auth/users — list all users (no passwords returned)
// ---------------------------------------------------------------------------
export async function listUsers(req, res) {
  const users = await User.find()
    .select('-passwordHash')
    .sort({ createdAt: -1 })
    .lean();
  res.json({ users });
}

// ---------------------------------------------------------------------------
// POST /api/auth/users — create a new user
// Auto-generates a unique username from their name if not supplied.
// ---------------------------------------------------------------------------
export async function createUser(req, res) {
  const { name, email, password, username: rawUsername } = req.body;

  if (!name || !email || !password) {
    return res.status(400).json({ error: 'name, email, and password are required.' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Invalid email address.' });
  }

  if (await User.findOne({ email: email.toLowerCase().trim() })) {
    return res.status(409).json({ error: 'A user with that email already exists.' });
  }

  // Build unique username
  let username = rawUsername
    ? rawUsername.toLowerCase().trim().replace(/[^a-z0-9_]/g, '_')
    : buildUsername(name);

  // Ensure uniqueness — append random suffix if taken
  let attempt = 0;
  while (await User.findOne({ username })) {
    attempt++;
    username = buildUsername(name, attempt);
  }

  const user = new User({ name: name.trim(), email: email.toLowerCase().trim(), username, role: 'user' });
  await user.setPassword(password);
  await user.save();

  res.status(201).json({ user: user.toJSON(), message: `User @${username} created successfully.` });
}

// ---------------------------------------------------------------------------
// DELETE /api/auth/users/:id — delete a user (cannot delete yourself)
// ---------------------------------------------------------------------------
export async function deleteUser(req, res) {
  if (req.params.id === req.user.id) {
    return res.status(400).json({ error: 'You cannot delete your own account.' });
  }
  const user = await User.findByIdAndDelete(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  res.json({ message: `User @${user.username} deleted.` });
}

// ---------------------------------------------------------------------------
// PATCH /api/auth/users/:id/password — change password
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
  res.json({ message: `Password updated for @${user.username}.` });
}

// ---------------------------------------------------------------------------
// POST /api/auth/seed-admin — first-time setup (open to anyone when 0 users exist)
// ---------------------------------------------------------------------------
export async function seedAdmin(req, res) {
  const count = await User.countDocuments();
  if (count > 0) {
    return res.status(403).json({ error: 'A user already exists. Seeding is disabled.' });
  }

  const { name, email, password, username: rawUsername } = req.body;
  if (!name || !email || !password || password.length < 8) {
    return res.status(400).json({ error: 'name, email, and password (min 8 chars) are required.' });
  }

  const username = rawUsername
    ? rawUsername.toLowerCase().trim().replace(/[^a-z0-9_]/g, '_')
    : buildUsername(name);

  const user = new User({ name: name.trim(), email: email.toLowerCase().trim(), username, role: 'user' });
  await user.setPassword(password);
  await user.save();

  res.status(201).json({ token: signToken(user), user: user.toJSON() });
}