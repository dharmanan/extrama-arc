'use strict';

const sessionService = require('../services/sessionService');
const { isHumanExecutionMode } = require('../services/executionIdentityService');

async function requireAuth(req, res, next) {
  try {
    const authorization = String(req.get('authorization') || '');
    if (!authorization.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'authentication_required' });
    }

    const token = authorization.slice('Bearer '.length).trim();
    const payload = sessionService.verifyToken(token);
    const active = await sessionService.getActiveSession(payload.jti);

    if (!active) {
      return res.status(401).json({ error: 'session_expired' });
    }

    // Only EXTERNAL_WALLET and CIRCLE_USER_WALLET sessions are accepted.
    // Legacy sessions recorded before the final architecture, and any
    // SYSTEM_SEED_WALLET identity, are rejected as invalid.
    if (
      !isHumanExecutionMode(active.executionMode) ||
      active.userId !== payload.sub ||
      active.ownerAddress !== payload.ownerAddress ||
      active.executionMode !== payload.executionMode ||
      (active.walletAddress || null) !== (payload.walletAddress || null) ||
      (active.circleWalletId || null) !== (payload.circleWalletId || null)
    ) {
      return res.status(401).json({ error: 'invalid_session' });
    }

    req.auth = {
      userId: active.userId,
      ownerAddress: active.ownerAddress,
      executionMode: active.executionMode,
      walletAddress: active.walletAddress,
      circleWalletId: active.circleWalletId,
      jti: payload.jti,
    };
    next();
  } catch {
    return res.status(401).json({ error: 'invalid_session' });
  }
}

module.exports = { requireAuth };
