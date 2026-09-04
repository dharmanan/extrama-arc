'use strict';

const { z } = require('zod');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3001),
  DATABASE_URL: z.string().min(1),
  ENCRYPTION_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/, 'ENCRYPTION_KEY must be 64 hex characters'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  CORS_ORIGINS: z.string().default('http://localhost:3000'),
  WEBAUTHN_RP_NAME: z.string().default('EXTREMA'),
  WEBAUTHN_RP_ID: z.string().optional().default(''),
  WEBAUTHN_ORIGINS: z.string().default('http://localhost:3000'),
  JWT_TTL_SECONDS: z.coerce.number().int().positive().default(1800),
  ALLOW_CODESPACE_ORIGINS: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
  ARC_TESTNET_RPC_URL: z.string().url().default("https://rpc.testnet.arc.network"),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  const issues = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('\n');
  throw new Error(`Invalid backend environment:\n${issues}`);
}

const env = parsed.data;

function splitCsv(value) {
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

module.exports = {
  ...env,
  corsOrigins: splitCsv(env.CORS_ORIGINS),
  webauthnOrigins: splitCsv(env.WEBAUTHN_ORIGINS),
};
