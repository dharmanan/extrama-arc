'use strict';

const arcService = require('./arcService');
const db = require('../db');
const {
  createArchiveSnapshotService,
  createPostgresArchiveSnapshotStore,
} = require('./archiveSnapshotService');

// One process-wide archive snapshot runtime. HTTP reads and lifecycle
// automation share the same in-memory snapshot and in-flight refresh.
module.exports = createArchiveSnapshotService({
  readRoundArchive: (params) => arcService.readRoundArchive(params),
  store: createPostgresArchiveSnapshotStore(db),
});
