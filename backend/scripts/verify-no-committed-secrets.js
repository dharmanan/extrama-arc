'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const files = execFileSync('git', ['ls-files', '-z'], {
  encoding: 'utf8',
}).split('\0').filter(Boolean);

const binaryExtensions = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico',
  '.pdf', '.woff', '.woff2', '.ttf', '.eot', '.zip',
]);

const patterns = [
  ['PRIVATE_KEY_BLOCK', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['GITHUB_TOKEN', /\b(?:ghp_|github_pat_)[A-Za-z0-9_]{20,}\b/],
  ['SLACK_TOKEN', /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/],
  ['AWS_ACCESS_KEY', /\bAKIA[0-9A-Z]{16}\b/],
  [
    'LITERAL_KEY_MATERIAL',
    /\b(?:ENCRYPTION_KEY|JWT_SECRET|PRIVATE_KEY|RESOLVER_PRIVATE_KEY)\s*[:=]\s*['"]?(?:0x)?[A-Fa-f0-9]{64}\b/,
  ],
];

const findings = [];

for (const file of files) {
  const base = path.basename(file);

  if (
    (base === '.env' || (base.startsWith('.env.') && !/\.env\.(example|sample|template)$/.test(base))) ||
    /\.(pem|key|p12|pfx)$/i.test(base) ||
    /^(id_rsa|id_ed25519)$/i.test(base)
  ) {
    findings.push(['SENSITIVE_FILENAME', file]);
  }

  if (binaryExtensions.has(path.extname(file).toLowerCase())) continue;

  let data;
  try {
    data = fs.readFileSync(file);
  } catch {
    continue;
  }

  if (data.subarray(0, 8192).includes(0)) continue;

  const text = data.toString('utf8');

  for (const [rule, regex] of patterns) {
    if (regex.test(text)) findings.push([rule, file]);
  }

  const dbUrls = text.matchAll(
    /\bpostgres(?:ql)?:\/\/[^:\s/]+:[^@\s]+@([^:/\s]+)/gi,
  );
  for (const match of dbUrls) {
    const host = String(match[1]).toLowerCase();
    if (!['localhost', '127.0.0.1'].includes(host)) {
      findings.push(['REMOTE_DATABASE_CREDENTIAL_URL', file]);
    }
  }
}

if (findings.length) {
  console.log('COMMITTED_SECRET_SCAN=FAIL');
  for (const [rule, file] of [...new Set(findings.map(JSON.stringify))].map(JSON.parse)) {
    console.log(`${rule}: ${file}`);
  }
  process.exitCode = 1;
} else {
  console.log('COMMITTED_SECRET_SCAN=PASS');
}
