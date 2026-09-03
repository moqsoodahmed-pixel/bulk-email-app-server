import jwt  from 'jsonwebtoken';
import User from '../models/User.js';

function signToken(user) {
  return jwt.sign(
    {
      sub:      user._id.toString(),
      email:    user.email,
      role:     user.role,
      name:     user.name,
      username: user.username || '',
    },
    process.env.JWT_SECRET,
    { expiresIn: '12h' }
  );
}

// Derive a URL-safe username from a display name
function buildUsername(name, suffix = '') {
  const base = name
    .toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 20);
  return suffix ? `${base}_${suffix}` : base;
}

// Get a unique username, appending numbers until free
async function uniqueUsername(name, preferred) {
  let candidate = preferred || buildUsername(name);
  let n = 0;
  while (await User.findOne({ username: candidate })) {
    n++;
    candidate = buildUsername(name, n);
  }
  return candidate;
}

// ---------------------------------------------------------------------------
// POST /api/auth/login
// Accepts email OR @username in the identifier field.
// Backward-compatible: old users (no username) can still log in by email.
// ---------------------------------------------------------------------------
export async function login(req, res) {
  const { identifier, email, password } = req.body;
  const raw = (identifier || email || '').trim();

  if (!raw || !password) {
    return res.status(400).json({ error: 'Email/username and password are required.' });
  }

  const lc      = raw.toLowerCase();
  const isEmail = lc.includes('@');

  // Always try email lookup first; fall back to username if no @ present
  let user = isEmail
    ? await User.findOne({ email: lc })
    : await User.findOne({ username: lc });

  // Fallback: if email lookup failed (typo without @), try username too
  if (!user && isEmail) user = await User.findOne({ username: lc });

  if (!user) {
    return res.status(401).json({ error: 'Invalid credentials.' });
  }

  const valid = await user.comparePassword(password);
  if (!valid) return res.status(401).json({ error: 'Invalid credentials.' });

  // Update lastLoginAt WITHOUT triggering full validation
  // (avoids ValidationError on old users missing username)
  await User.findByIdAndUpdate(user._id, { lastLoginAt: new Date() });

  res.json({ token: signToken(user), user: user.toJSON() });
}

// ---------------------------------------------------------------------------
// POST /api/auth/register  — open public self-registration
// Anyone can create their own account. No invite needed.
// ---------------------------------------------------------------------------
export async function register(req, res) {
  const { name, email, password, username: rawU } = req.body;

  if (!name || !email || !password) {
    return res.status(400).json({ error: 'Name, email, and password are required.' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Invalid email address.' });
  }

  const emailLc = email.toLowerCase().trim();
  if (await User.findOne({ email: emailLc })) {
    return res.status(409).json({ error: 'An account with that email already exists. Please sign in instead.' });
  }

  const preferred = rawU ? rawU.toLowerCase().trim().replace(/[^a-z0-9_]/g, '_').slice(0, 20) : null;
  const username  = await uniqueUsername(name, preferred);

  // Check preferred username taken — give friendly message
  if (rawU && username !== preferred) {
    return res.status(409).json({
      error: `Username @${preferred} is already taken. Try @${username} or choose a different one.`,
      suggestion: username,
    });
  }

  const user = new User({ name: name.trim(), email: emailLc, username, role: 'user' });
  await user.setPassword(password);
  await user.save();

  res.status(201).json({ token: signToken(user), user: user.toJSON() });
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
// GET /api/auth/users — list all users
// ---------------------------------------------------------------------------
export async function listUsers(req, res) {
  const users = await User.find()
    .select('-passwordHash')
    .sort({ createdAt: -1 })
    .lean();
  res.json({ users });
}

// ---------------------------------------------------------------------------
// POST /api/auth/users — create user (by existing user, from Users page)
// ---------------------------------------------------------------------------
export async function createUser(req, res) {
  const { name, email, password, username: rawU } = req.body;

  if (!name || !email || !password) {
    return res.status(400).json({ error: 'Name, email, and password are required.' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Invalid email address.' });
  }

  const emailLc = email.toLowerCase().trim();
  if (await User.findOne({ email: emailLc })) {
    return res.status(409).json({ error: 'A user with that email already exists.' });
  }

  const preferred = rawU ? rawU.toLowerCase().trim().replace(/[^a-z0-9_]/g, '_').slice(0, 20) : null;
  const username  = await uniqueUsername(name, preferred);

  const user = new User({ name: name.trim(), email: emailLc, username, role: 'user' });
  await user.setPassword(password);
  await user.save();

  res.status(201).json({ user: user.toJSON(), message: `User @${username} created.` });
}

// ---------------------------------------------------------------------------
// DELETE /api/auth/users/:id
// ---------------------------------------------------------------------------
export async function deleteUser(req, res) {
  if (req.params.id === req.user.id) {
    return res.status(400).json({ error: 'You cannot delete your own account.' });
  }
  const user = await User.findByIdAndDelete(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  res.json({ message: `User ${user.username ? '@' + user.username : user.email} deleted.` });
}

// ---------------------------------------------------------------------------
// PATCH /api/auth/users/:id/password
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
  res.json({ message: 'Password updated.' });
}

// ---------------------------------------------------------------------------
// POST /api/auth/seed-admin — kept for backward compat, now just calls register
// ---------------------------------------------------------------------------
export async function seedAdmin(req, res) {
  return register(req, res);
}
