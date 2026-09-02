import jwt from 'jsonwebtoken';
import User from '../models/User.js';

function signToken(user) {
  return jwt.sign(
    { sub: user._id.toString(), email: user.email, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: '12h' }
  );
}

export async function login(req, res) {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  const user = await User.findOne({ email: email.toLowerCase().trim() });
  // Same generic error whether user is missing or password is wrong —
  // avoids leaking which emails are registered.
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

export async function me(req, res) {
  const user = await User.findById(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ user: user.toJSON() });
}

// One-time bootstrap endpoint to create the first admin account.
// Disabled automatically once any user already exists.
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
