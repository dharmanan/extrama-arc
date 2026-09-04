'use strict';

const { Pool } = require('pg');
const config = require('./config');

const pool = new Pool({
  connectionString: config.DATABASE_URL,
  ssl: config.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined,
  max: 10,
});

pool.on('error', (error) => {
  console.error('[db] unexpected pool error', error);
});

module.exports = {
  query(text, params) {
    return pool.query(text, params);
  },
  getClient() {
    return pool.connect();
  },
  async ping() {
    await pool.query('SELECT 1');
  },
  async close() {
    await pool.end();
  },
};
