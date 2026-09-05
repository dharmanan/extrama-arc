'use strict';

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const { ZodError } = require('zod');

const config = require('./config');
const db = require('./db');
const authRoutes = require('./routes/auth');
const walletRoutes = require('./routes/wallet');
const roundRoutes = require('./routes/rounds');
const arcService = require('./services/arcService');

const app = express();

app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));

app.use(cors({
  origin(origin, callback) {
    if (!origin) return callback(null, true);

    if (config.corsOrigins.includes(origin)) {
      return callback(null, true);
    }

    if (config.NODE_ENV !== 'production') {
      try {
        const host = new URL(origin).hostname;
        if (host.endsWith('.app.github.dev') || host === 'localhost' || host === '127.0.0.1') {
          return callback(null, true);
        }
      } catch {}
    }

    callback(new Error('cors_origin_not_allowed'));
  },
  credentials: false,
}));

app.use(express.json({ limit: '64kb' }));

app.get('/readyz', (req, res) => {
  res.json({ ok: true, service: 'extrema-backend' });
});

app.get('/health', async (req, res) => {
  try {
    await db.ping();
    res.json({ ok: true, database: 'connected' });
  } catch {
    res.status(503).json({ ok: false, database: 'unavailable' });
  }
});

app.use('/api/auth', authRoutes);
app.use('/api/wallet', walletRoutes);
app.use('/api/rounds', roundRoutes);

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);

  if (error instanceof ZodError) {
    return res.status(400).json({
      error: 'invalid_request',
      details: error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
  }

  const safeKnownErrors = new Set([
    'webauthn_origin_not_allowed',
    'challenge_expired',
    'passkey_registration_failed',
    'passkey_not_registered',
    'passkey_not_found',
    'passkey_authentication_failed',
  ]);

  if (safeKnownErrors.has(error.message)) {
    return res.status(400).json({ error: error.message });
  }

  console.error('[api]', error);
  res.status(500).json({ error: 'internal_server_error' });
});

const server = app.listen(config.PORT, () => {
  console.log(`[extrema-backend] listening on :${config.PORT}`);
  arcService.warmStandardRoundsCache();
});

async function shutdown(signal) {
  console.log(`[extrema-backend] ${signal}, shutting down`);
  server.close(async () => {
    await db.close();
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
