import express from 'express';
import Database from 'better-sqlite3';
import Anthropic from '@anthropic-ai/sdk';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.use(express.json());

const db = new Database('conversations.db');
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT =
  'You are JARVIS, a personal AI assistant. Be concise and warm. ' +
  'Keep voice responses under 3 sentences unless detail is requested.';

// Initialize DB
db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    role      TEXT    NOT NULL,
    content   TEXT    NOT NULL,
    source    TEXT    NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

const insertMessage = db.prepare(
  'INSERT INTO messages (role, content, source) VALUES (?, ?, ?)'
);

const getRecentMessages = db.prepare(
  'SELECT role, content FROM messages ORDER BY id DESC LIMIT 20'
);

// Auth middleware
function authenticate(req, res, next) {
  const key = req.headers['x-relay-key'];
  if (!key || key !== process.env.RELAY_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

app.post('/ask', authenticate, async (req, res) => {
  const { query, source } = req.body;

  if (!query || typeof query !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid "query" field' });
  }
  if (!source || typeof source !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid "source" field' });
  }

  // Persist the user message
  insertMessage.run('user', query, source);

  // Fetch last 20 messages (newest first), then reverse for chronological order
  const history = getRecentMessages.all().reverse();

  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: history,
    });

    const reply = response.content[0].text;

    // Persist the assistant reply
    insertMessage.run('assistant', reply, source);

    res.json({ reply, source });
  } catch (err) {
    console.error('Anthropic API error:', err);
    res.status(502).json({ error: 'Failed to get response from AI' });
  }
});

// Health check
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`JARVIS relay listening on port ${PORT}`);
});
