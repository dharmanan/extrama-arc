'use strict';

const sessionService = require('../services/sessionService');

async function requireAuth(req, res, next) {
  try {
    const authorization = String(req.get('authorization') || '');
    if (!authorization.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'authentication_required' });
    }

    const token = authorization.slice('Bearer '.length).trim();
    const payload = sessionService.verifyToken(token);
    const active = await sessionService.isSessionActive(payload.jti);

    if (!active) {
      return res.status(401).json({ error: 'session_expired' });
    }

    req.auth = {
      userId: payload.sub,
      ownerAddress: payload.ownerAddress,
      jti: payload.jti,
    };
    next();
  } catch {
    return res.status(401).json({ error: 'invalid_session' });
  }
}

module.exports = { requireAuth };
