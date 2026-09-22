'use strict';

const { execFileSync } = require('node:child_process');

const MAX_BUFFER = 512 * 1024 * 1024;

function git(args) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

const patterns = [
  ['PRIVATE_KEY_BLOCK', /-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
  ['GITHUB_TOKEN', /\b(?:ghp_|github_pat_)[A-Za-z0-9_]{20,}\b/g],
  ['SLACK_TOKEN', /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g],
  ['AWS_ACCESS_KEY', /\bAKIA[0-9A-Z]{16}\b/g],
  ['GOOGLE_API_KEY', /\bAIza[0-9A-Za-z_-]{30,}\b/g],
  ['GOOGLE_CLIENT_SECRET', /\bGOCSPX-[0-9A-Za-z_-]{20,}\b/g],
  ['CIRCLE_API_KEY', /\b(?:TEST|LIVE|SAND)_API_KEY:[A-Za-z0-9_-]{10,}\b/g],
  [
    'LITERAL_KEY_MATERIAL',
    /\b(?:ENCRYPTION_KEY|JWT_SECRET|PRIVATE_KEY|RESOLVER_PRIVATE_KEY)\s*[:=]\s*['"]?(?:0x)?[A-Fa-f0-9]{64}\b/g,
  ],
  [
    'REMOTE_DATABASE_CREDENTIAL_URL',
    /\bpostgres(?:ql)?:\/\/[^:\s/]+:[^@\s]+@(?!(?:localhost|127\.0\.0\.1)(?:[:/]))[^/\s]+/gi,
  ],
  [
    'MNEMONIC_ASSIGNMENT',
    /\b(?:mnemonic|seed(?:_phrase)?)\s*[:=]\s*['"][a-z]+(?:\s+[a-z]+){11,23}['"]/gi,
  ],
  ['PERSONAL_GMAIL_ADDRESS', /\b[A-Za-z0-9._%+-]+@gmail\.com\b/gi],
];

function isSensitiveFilename(file) {
  const base = file.split('/').pop() || file;

  if (
    base === '.env' ||
    (
      base.startsWith('.env.') &&
      !/\.env\.(?:example|sample|template)$/i.test(base)
    )
  ) {
    return true;
  }

  return (
    /\.(?:pem|key|p12|pfx)$/i.test(base) ||
    /^(?:id_rsa|id_ed25519)$/i.test(base)
  );
}

const archiveFilename = /\.(?:zip|7z|rar|tar|tgz|gz)$/i;

const names = git([
  'log',
  '--all',
  '--full-history',
  '--name-only',
  '--format=@@COMMIT:%H',
  '--no-renames',
]);

const findings = new Map();
const historicalArchives = new Set();
let currentCommit = 'unknown';

for (const line of names.split('\n')) {
  if (line.startsWith('@@COMMIT:')) {
    currentCommit = line.slice('@@COMMIT:'.length).trim();
    continue;
  }

  const file = line.trim();
  if (!file) continue;

  if (isSensitiveFilename(file)) {
    findings.set(
      'SENSITIVE_FILENAME|' + file + '|' + currentCommit,
      {
        rule: 'SENSITIVE_FILENAME',
        file,
        commit: currentCommit,
      },
    );
  }

  if (archiveFilename.test(file)) {
    historicalArchives.add(file);
  }
}

const patch = git([
  'log',
  '--all',
  '--full-history',
  '--no-color',
  '--no-ext-diff',
  '--format=@@COMMIT:%H',
  '-p',
  '--no-renames',
]);

currentCommit = 'unknown';
let currentFile = 'unknown';

for (const line of patch.split('\n')) {
  if (line.startsWith('@@COMMIT:')) {
    currentCommit = line.slice('@@COMMIT:'.length).trim();
    currentFile = 'unknown';
    continue;
  }

  if (line.startsWith('+++ b/')) {
    currentFile = line.slice(6).trim();
    continue;
  }

  if (line.startsWith('--- a/') && currentFile === 'unknown') {
    currentFile = line.slice(6).trim();
    continue;
  }

  if (!line.startsWith('+') && !line.startsWith('-')) {
    continue;
  }

  if (line.startsWith('+++') || line.startsWith('---')) {
    continue;
  }

  const candidate = line.slice(1);

  for (const [rule, regex] of patterns) {
    regex.lastIndex = 0;
    if (!regex.test(candidate)) continue;

    findings.set(
      rule + '|' + currentFile + '|' + currentCommit,
      { rule, file: currentFile, commit: currentCommit },
    );
  }
}

const results = [...findings.values()];
const commitCount = git(['rev-list', '--all', '--count']).trim();

console.log('HISTORY_COMMITS_SCANNED=' + commitCount);

if (historicalArchives.size > 0) {
  console.log(
    'HISTORY_BINARY_ARCHIVES_PRESENT=' + historicalArchives.size,
  );
  for (const file of [...historicalArchives].sort()) {
    console.log('HISTORY_BINARY_ARCHIVE=' + file);
  }
}

if (results.length > 0) {
  console.log('FULL_HISTORY_SECRET_SCAN=FAIL');
  for (const finding of results) {
    console.log(
      finding.rule + ': ' + finding.file + ' @ ' + finding.commit,
    );
  }
  process.exitCode = 1;
} else {
  console.log('FULL_HISTORY_SECRET_SCAN=PASS');
}
