const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const dataDir = path.join(process.cwd(), 'data');
const dbPath = path.join(dataDir, 'studyrag.sqlite');

function ensureDataDir() {
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
}

function openDatabase() {
  ensureDataDir();
  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  return db;
}

function tableExists(db, tableName) {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName);
  return !!row;
}

function getCount(db, tableName) {
  if (!tableExists(db, tableName)) {
    return 0;
  }
  return db.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get().count;
}

function logAction(actions, sql, description) {
  actions.push({ sql, description });
}

function ensureNewTables(db, actions) {
  const statements = [
    {
      description: 'Create sessions table',
      sql: `CREATE TABLE IF NOT EXISTS sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );`,
    },
    {
      description: 'Create pdfs table',
      sql: `CREATE TABLE IF NOT EXISTS pdfs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sessionId INTEGER NOT NULL,
        title TEXT NOT NULL,
        filename TEXT NOT NULL,
        path TEXT NOT NULL,
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        indexedChunks INTEGER NOT NULL DEFAULT 0,
        createdAt TEXT NOT NULL,
        FOREIGN KEY (sessionId) REFERENCES sessions(id) ON DELETE CASCADE
      );`,
    },
    {
      description: 'Create chunks table',
      sql: `CREATE TABLE IF NOT EXISTS chunks (
        id TEXT PRIMARY KEY,
        sessionId INTEGER NOT NULL,
        pdfId INTEGER,
        text TEXT NOT NULL,
        embedding TEXT NOT NULL,
        embeddingVectorLength INTEGER NOT NULL DEFAULT 0,
        createdAt TEXT NOT NULL,
        FOREIGN KEY (sessionId) REFERENCES sessions(id) ON DELETE CASCADE,
        FOREIGN KEY (pdfId) REFERENCES pdfs(id) ON DELETE CASCADE
      );`,
    },
    {
      description: 'Create chat_history table',
      sql: `CREATE TABLE IF NOT EXISTS chat_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sessionId INTEGER NOT NULL,
        role TEXT NOT NULL,
        text TEXT NOT NULL,
        metadata TEXT,
        createdAt TEXT NOT NULL,
        FOREIGN KEY (sessionId) REFERENCES sessions(id) ON DELETE CASCADE
      );`,
    },
    {
      description: 'Create sessions updatedAt index',
      sql: 'CREATE INDEX IF NOT EXISTS idx_sessions_updatedAt ON sessions(updatedAt);',
    },
    {
      description: 'Create pdfs sessionId index',
      sql: 'CREATE INDEX IF NOT EXISTS idx_pdfs_sessionId ON pdfs(sessionId);',
    },
    {
      description: 'Create pdfs status index',
      sql: 'CREATE INDEX IF NOT EXISTS idx_pdfs_status ON pdfs(status);',
    },
    {
      description: 'Create chunks sessionId index',
      sql: 'CREATE INDEX IF NOT EXISTS idx_chunks_sessionId ON chunks(sessionId);',
    },
    {
      description: 'Create chunks pdfId index',
      sql: 'CREATE INDEX IF NOT EXISTS idx_chunks_pdfId ON chunks(pdfId);',
    },
    {
      description: 'Create chunks createdAt index',
      sql: 'CREATE INDEX IF NOT EXISTS idx_chunks_createdAt ON chunks(createdAt);',
    },
    {
      description: 'Create chat_history sessionId index',
      sql: 'CREATE INDEX IF NOT EXISTS idx_chat_history_sessionId ON chat_history(sessionId);',
    },
  ];

  for (const statement of statements) {
    logAction(actions, statement.sql, statement.description);
    db.exec(statement.sql);
  }
}

function migrateLegacyData(db, actions) {
  const hasSubjects = tableExists(db, 'subjects');
  const hasDocuments = tableExists(db, 'documents');
  const hasEmbeddings = tableExists(db, 'embeddings');

  if (!hasSubjects && !hasDocuments && !hasEmbeddings) {
    return;
  }

  const sessionsCount = getCount(db, 'sessions');
  const pdfsCount = getCount(db, 'pdfs');
  const chunksCount = getCount(db, 'chunks');

  if (hasSubjects && sessionsCount === 0) {
    const sql = `
      INSERT INTO sessions (id, title, createdAt, updatedAt)
      SELECT id, name, datetime('now'), datetime('now')
      FROM subjects;
    `;
    logAction(actions, sql.trim(), 'Migrate subjects -> sessions');
    db.exec(sql);
  }

  if (hasDocuments && pdfsCount === 0) {
    const sql = `
      INSERT INTO pdfs (id, sessionId, title, filename, path, type, status, indexedChunks, createdAt)
      SELECT
        d.id,
        d.subjectId,
        d.title,
        d.path,
        d.path,
        lower(d.type),
        'indexed',
        0,
        COALESCE(d.createdAt, datetime('now'))
      FROM documents d;
    `;
    logAction(actions, sql.trim(), 'Migrate documents -> pdfs');
    db.exec(sql);

    const updateSql = `
      UPDATE pdfs
      SET indexedChunks = (
        SELECT COUNT(*)
        FROM embeddings e
        WHERE e.documentId = pdfs.id
      )
      WHERE id IN (SELECT id FROM pdfs);
    `;
    logAction(actions, updateSql.trim(), 'Backfill indexedChunks on migrated pdfs');
    if (hasEmbeddings) {
      db.exec(updateSql);
    }
  }

  if (hasEmbeddings && chunksCount === 0) {
    const columns = db.prepare('PRAGMA table_info(embeddings)').all().map((column) => column.name);
    const hasSubjectId = columns.includes('subjectId');
    const hasDocumentId = columns.includes('documentId');

    const sql = `
      INSERT INTO chunks (id, sessionId, pdfId, text, embedding, embeddingVectorLength, createdAt)
      SELECT
        id,
        ${hasSubjectId ? 'subjectId' : '1'},
        ${hasDocumentId ? 'documentId' : 'NULL'},
        text,
        embedding,
        COALESCE(json_array_length(embedding), 0),
        COALESCE(createdAt, datetime('now'))
      FROM embeddings;
    `;
    logAction(actions, sql.trim(), 'Migrate embeddings -> chunks');
    db.exec(sql);
  }

  const ensureDefaultSessionSql = `
    INSERT OR IGNORE INTO sessions (id, title, createdAt, updatedAt)
    VALUES (1, 'General', datetime('now'), datetime('now'));
  `;
  logAction(actions, ensureDefaultSessionSql.trim(), 'Ensure default session exists');
  db.exec(ensureDefaultSessionSql);
}

function runMigrations({ dryRun = false } = {}) {
  const db = openDatabase();
  const actions = [];

  const execute = () => {
    ensureNewTables(db, actions);
    migrateLegacyData(db, actions);
  };

  if (dryRun) {
    db.exec('BEGIN;');
    try {
      execute();
      db.exec('ROLLBACK;');
    } catch (error) {
      db.exec('ROLLBACK;');
      db.close();
      throw error;
    }
  } else {
    execute();
  }

  db.close();
  return actions;
}

module.exports = {
  dbPath,
  openDatabase,
  runMigrations,
};
