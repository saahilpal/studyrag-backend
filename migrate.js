#!/usr/bin/env node

const { runMigrations } = require('./db/migration');

const dryRun = process.argv.includes('--dry-run');

try {
  const actions = runMigrations({ dryRun });
  const mode = dryRun ? 'DRY RUN' : 'EXECUTE';
  // eslint-disable-next-line no-console
  console.log(`[migrate] mode=${mode} actions=${actions.length}`);
  actions.forEach((action, index) => {
    // eslint-disable-next-line no-console
    console.log(`${index + 1}. ${action.description}`);
    // eslint-disable-next-line no-console
    console.log(`   SQL: ${action.sql.replace(/\s+/g, ' ').trim()}`);
  });
} catch (error) {
  // eslint-disable-next-line no-console
  console.error('[migrate] failed:', error.message);
  process.exitCode = 1;
}
