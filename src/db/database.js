const { openDatabase, runMigrations } = require('./migration');

runMigrations({ dryRun: false });

const db = openDatabase();

module.exports = db;
