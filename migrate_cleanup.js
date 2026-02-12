#!/usr/bin/env node

const { openDatabase } = require('./db/migration');

const db = openDatabase();

const legacyTables = ['subjects', 'documents', 'embeddings'];
const dropped = [];

for (const tableName of legacyTables) {
  const exists = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
    .get(tableName);

  if (!exists) {
    continue;
  }

  db.exec(`DROP TABLE ${tableName};`);
  dropped.push(tableName);
}

// eslint-disable-next-line no-console
console.log(`[migrate_cleanup] dropped=${dropped.join(',') || 'none'}`);

db.close();
