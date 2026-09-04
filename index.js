import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { connectDB } from './config/db.js';
import { apiLimiter } from './middleware/rateLimiters.js';
import { notFound, errorHandler } from './middleware/errorHandler.js';

import authRoutes    from './routes/authRoutes.js';
import leadRoutes    from './routes/leadRoutes.js';
import campaignRoutes from './routes/campaignRoutes.js';
import logRoutes     from './routes/logRoutes.js';

const REQUIRED_ENV = ['MONGO_URI', 'JWT_SECRET'];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`[startup] Missing required env var: ${key}`);
    process.exit(1);
  }
}

const app = express();
app.set('trust proxy', 1);

app.use(helmet());
app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (curl, Postman, server-to-server)
      if (!origin) return callback(null, true);

      const allowed = [
        // Production CF Pages domain
        'https://bulk-email-app-client.pages.dev',
        // localhost dev
        'http://localhost:5173',
        // Explicit override from .env (e.g. c5831fe3.bulk-email-app-client.pages.dev)
        process.env.FRONTEND_URL,
      ].filter(Boolean);

      // Also allow ANY Cloudflare Pages preview deployment for this project
      // Pattern: https://<hash>.bulk-email-app-client.pages.dev
      const isCFPreview = /^https:\/\/[a-z0-9]+\.bulk-email-app-client\.pages\.dev$/.test(origin);

      if (isCFPreview || allowed.includes(origin)) {
        return callback(null, true);
      }
      console.warn('[cors] Blocked origin:', origin);
      return callback(new Error(`CORS: origin not allowed — ${origin}`));
    },
    credentials: true,
  })
);
app.use(express.json({ limit: '2mb' }));
app.use('/api', apiLimiter);

app.get('/api/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

app.use('/api/auth',      authRoutes);
app.use('/api/leads',     leadRoutes);
app.use('/api/campaigns', campaignRoutes);
app.use('/api/logs',      logRoutes);

app.use(notFound);
app.use(errorHandler);

const PORT = process.env.PORT || 4000;

async function start() {
  await connectDB();
  app.listen(PORT, () => {
    console.log(`[server] Listening on port ${PORT}`);
  });
}

start().catch((err) => {
  console.error('[startup] Failed to start server:', err);
  process.exit(1);
});