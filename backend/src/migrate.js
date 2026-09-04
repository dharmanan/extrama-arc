'use strict';

const fs = require('fs');
const path = require('path');
const db = require('./db');

async function main() {
  const schemaPath = path.join(__dirname, 'db', 'schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf8');
  await db.query(sql);
  console.log('[db] schema ready');
  await db.close();
}

main().catch((error) => {
  console.error('[db] migration failed', error);
  process.exitCode = 1;
});
