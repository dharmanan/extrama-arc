'use strict';

const { z } = require('zod');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3001),
  DATABASE_URL: z.string().min(1),
  ENCRYPTION_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/, 'ENCRYPTION_KEY must be 64 hex characters'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  CORS_ORIGINS: z.string().default('http://localhost:3000'),
  JWT_TTL_SECONDS: z.coerce.number().int().positive().default(1800),
  // Optional during rollout. Circle routes fail closed until this server-only
  // credential is configured; the browser never receives it.
  CIRCLE_API_KEY: z.string().min(1).optional(),
  ARC_TESTNET_RPC_URL: z.string().url().default("https://rpc.testnet.arc.network"),
  EXTREMA_FACTORY_ADDRESS: z.string().default("0xa7Bff22811Bb1BA9297DFaA611De58E3bc186D7A"),
  // Canonical Arc Testnet deployment (deploy tx 0x9b35faa5a16d46056c833ac5b7cb6186f37200e0e3d5c0b8ce0f328914474304),
  // post-deploy verified: USDC()/FACTORY() match the canonical addresses above, nextListingId()==1.
  EXTREMA_MARKETPLACE_ADDRESS: z.string().default("0x0C50FE3edD739B7268d58E1414F973e9A55dd037"),
  // Safety gate: disabled by default. Creation is enabled only after canonical
  // V2 timing has passed validation and the deployment explicitly opts in.
  EXTREMA_ENABLE_ROUND_CREATION: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
  // Seed agents remain fail-closed unless Railway explicitly opts in.
  // LIVE execution also retains its separate executor + fresh-chain-state gates.
  EXTREMA_ENABLE_SEED_BOTS: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
  // AES-256-GCM envelope (v1.iv.ct.tag) of the resolver private key, produced
  // with the same ENCRYPTION_KEY used for wallet material. Optional: when it is
  // absent, resolver signing stays disabled and the rest of the lifecycle runs
  // normally. Plaintext key material is never accepted here.
  EXTREMA_RESOLVER_PRIVATE_KEY_ENCRYPTED: z
    .string()
    .regex(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/, 'must be a v1 AES-256-GCM envelope')
    .optional(),
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
};
