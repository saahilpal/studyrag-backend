const db = require('../db/database');
const ALLOWED_ROLES = new Set(['user', 'assistant', 'system']);

const insertMessageStmt = db.prepare(`
  INSERT INTO chat_messages (sessionId, role, text, createdAt)
  VALUES (@sessionId, @role, @text, @createdAt)
`);

const updateSessionMessageMetadataStmt = db.prepare(`
  UPDATE sessions
  SET last_message_at = @createdAt,
      last_message_preview = @lastMessagePreview
  WHERE id = @sessionId
`);

const listMessagesStmt = db.prepare(`
  SELECT
    id,
    role,
    text,
    COALESCE(NULLIF(createdAt, ''), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) AS createdAt
  FROM chat_messages
  WHERE sessionId = @sessionId
  ORDER BY createdAt ASC, id ASC
  LIMIT @limit
  OFFSET @offset
`);

const deleteMessagesStmt = db.prepare(`
  DELETE FROM chat_messages
  WHERE sessionId = ?
`);

const clearSessionMessageMetadataStmt = db.prepare(`
  UPDATE sessions
  SET last_message_at = NULL,
      last_message_preview = NULL
  WHERE id = ?
`);

const addMessageTx = db.transaction(({ sessionId, role, text, createdAt }) => {
  insertMessageStmt.run({
    sessionId,
    role,
    text,
    createdAt,
  });
  updateSessionMessageMetadataStmt.run({
    sessionId,
    createdAt,
    lastMessagePreview: String(text).slice(0, 160),
  });
});

const addConversationTx = db.transaction(({ sessionId, userText, assistantText, userCreatedAt, assistantCreatedAt }) => {
  insertMessageStmt.run({
    sessionId,
    role: 'user',
    text: userText,
    createdAt: userCreatedAt,
  });

  insertMessageStmt.run({
    sessionId,
    role: 'assistant',
    text: assistantText,
    createdAt: assistantCreatedAt,
  });

  updateSessionMessageMetadataStmt.run({
    sessionId,
    createdAt: assistantCreatedAt,
    lastMessagePreview: String(assistantText).slice(0, 160),
  });
});

function normalizeMessageText(text) {
  const normalizedText = String(text || '').trim();
  if (!normalizedText) {
    const error = new Error('Chat message text is required.');
    error.statusCode = 400;
    throw error;
  }
  return normalizedText;
}

function addMessage({ sessionId, role, text, createdAt }) {
  if (!ALLOWED_ROLES.has(role)) {
    const error = new Error('Invalid chat role.');
    error.statusCode = 400;
    throw error;
  }
  const normalizedText = normalizeMessageText(text);

  const timestamp = createdAt || new Date().toISOString();
  addMessageTx({
    sessionId,
    role,
    text: normalizedText,
    createdAt: timestamp,
  });
}

function addConversation({ sessionId, userText, assistantText, createdAt }) {
  const normalizedUserText = normalizeMessageText(userText);
  const normalizedAssistantText = normalizeMessageText(assistantText);
  const userCreatedAt = createdAt || new Date().toISOString();
  const assistantCreatedAt = new Date(new Date(userCreatedAt).getTime() + 1).toISOString();

  addConversationTx({
    sessionId,
    userText: normalizedUserText,
    assistantText: normalizedAssistantText,
    userCreatedAt,
    assistantCreatedAt,
  });
}

function listSessionHistory(sessionId, options = {}) {
  const requestedLimit = Number(options.limit ?? 1000);
  const requestedOffset = Number(options.offset ?? 0);
  const limit = Number.isInteger(requestedLimit) && requestedLimit > 0
    ? Math.min(requestedLimit, 5000)
    : 1000;
  const offset = Number.isInteger(requestedOffset) && requestedOffset >= 0
    ? requestedOffset
    : 0;

  return listMessagesStmt
    .all({ sessionId, limit, offset })
    .map((row) => ({
      id: String(row.id),
      role: row.role,
      text: row.text,
      createdAt: row.createdAt,
    }));
}

function clearSessionHistory(sessionId) {
  const clearTx = db.transaction((id) => {
    deleteMessagesStmt.run(id);
    clearSessionMessageMetadataStmt.run(id);
  });
  clearTx(sessionId);
  return { cleared: true };
}

module.exports = {
  addMessage,
  addConversation,
  listSessionHistory,
  clearSessionHistory,
};
