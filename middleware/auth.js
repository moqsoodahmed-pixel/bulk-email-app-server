import jwt from 'jsonwebtoken';

export function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Authentication required.' });
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = {
      id:       payload.sub,
      email:    payload.email,
      role:     payload.role,
      name:     payload.name     || '',
      username: payload.username || payload.name || '',
    };
    return next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token.' });
  }
}

// All logged-in users have equal access — no role distinction.
export const requireAdmin = requireAuth;
