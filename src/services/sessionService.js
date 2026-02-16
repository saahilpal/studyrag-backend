const db = require('../db/database');
const sessionColumns = db.prepare('PRAGMA table_info(sessions)').all().map((column) => column.name);
const hasUpdatedAtColumn = sessionColumns.includes('updatedAt');

const listSessionsStmt = db.prepare(`
  SELECT
    s.id,
    s.title,
    s.createdAt,
    s.last_message_at AS lastMessageAt,
    COALESCE(s.last_message_preview, '') AS lastMessagePreview,
    COALESCE(cm.messageCount, 0) AS messageCount,
    COALESCE(pc.pdfCount, 0) AS pdfCount
  FROM sessions s
  LEFT JOIN (
    SELECT sessionId, COUNT(*) AS messageCount
    FROM chat_messages
    GROUP BY sessionId
  ) cm ON cm.sessionId = s.id
  LEFT JOIN (
    SELECT sessionId, COUNT(*) AS pdfCount
    FROM pdfs
    GROUP BY sessionId
  ) pc ON pc.sessionId = s.id
  ORDER BY (s.last_message_at IS NULL) ASC, s.last_message_at DESC, s.id DESC
`);

const insertSessionStmt = hasUpdatedAtColumn
  ? db.prepare(`
      INSERT INTO sessions (title, createdAt, updatedAt)
      VALUES (@title, @createdAt, @updatedAt)
    `)
  : db.prepare(`
      INSERT INTO sessions (title, createdAt)
      VALUES (@title, @createdAt)
    `);

const getSessionStmt = db.prepare(`
  SELECT id, title, createdAt, last_message_at AS lastMessageAt, COALESCE(last_message_preview, '') AS lastMessagePreview
  FROM sessions
  WHERE id = ?
`);

const deleteSessionStmt = db.prepare(`
  DELETE FROM sessions
  WHERE id = ?
`);

const deleteSessionPdfsStmt = db.prepare(`
  DELETE FROM pdfs
  WHERE sessionId = ?
`);

const deleteSessionChunksStmt = db.prepare(`
  DELETE FROM chunks
  WHERE sessionId = ?
`);

const deleteSessionHistoryStmt = db.prepare(`
  DELETE FROM chat_messages
  WHERE sessionId = ?
`);

function listSessions() {
  return listSessionsStmt.all().map((session) => ({
    ...session,
    title: String(session.title || '').trim() || `Session ${session.id}`,
    lastMessageAt: session.lastMessageAt || null,
    lastMessagePreview: String(session.lastMessagePreview || ''),
    messageCount: Number(session.messageCount || 0),
    pdfCount: Number(session.pdfCount || 0),
  }));
}

function getSessionById(sessionId) {
  return getSessionStmt.get(sessionId) || null;
}

function createSession(title) {
  const normalizedTitle = String(title || '').trim();
  if (!normalizedTitle) {
    const error = new Error('title is required and must be a string.');
    error.statusCode = 400;
    throw error;
  }

  const now = new Date().toISOString();
  const payload = {
    title: normalizedTitle,
    createdAt: now,
  };
  if (hasUpdatedAtColumn) {
    payload.updatedAt = now;
  }
  const result = insertSessionStmt.run(payload);

  return getSessionById(Number(result.lastInsertRowid));
}

function assertSessionExists(sessionId) {
  const session = getSessionById(sessionId);
  if (!session) {
    const error = new Error('sessionId does not exist.');
    error.statusCode = 400;
    throw error;
  }
  return session;
}

function deleteSession(sessionId) {
  assertSessionExists(sessionId);

  const remove = db.transaction((id) => {
    deleteSessionHistoryStmt.run(id);
    deleteSessionChunksStmt.run(id);
    deleteSessionPdfsStmt.run(id);
    deleteSessionStmt.run(id);
  });

  remove(sessionId);
  return { deleted: true, id: sessionId };
}

module.exports = {
  listSessions,
  createSession,
  getSessionById,
  assertSessionExists,
  deleteSession,
};
