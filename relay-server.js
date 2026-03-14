import express from 'express';
import Database from 'better-sqlite3';
import Anthropic from '@anthropic-ai/sdk';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf.toString('utf8');
    },
  })
);

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

const WEB_SEARCH_TOOLS = [{ type: 'web_search_20250305', name: 'web_search' }];

// Run the Claude agentic loop with web search, returning the final text reply.
async function runAgenticLoop(model, history) {
  const messages = [...history];

  let response = await client.messages.create({
    model,
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages,
    tools: WEB_SEARCH_TOOLS,
  });

  while (response.stop_reason === 'tool_use') {
    console.debug('[agentic] tool_use round, content:', JSON.stringify(response.content));

    // Append Claude's turn (contains tool_use blocks)
    messages.push({ role: 'assistant', content: response.content });

    // For server-side tools like web_search, Anthropic returns tool_result
    // blocks inside the same content array. Forward them as the user turn.
    const toolResultBlocks = response.content.filter(b => b.type === 'tool_result');

    if (toolResultBlocks.length > 0) {
      messages.push({ role: 'user', content: toolResultBlocks });
    } else {
      // Fallback: acknowledge every tool_use so the loop can proceed
      const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');
      messages.push({
        role: 'user',
        content: toolUseBlocks.map(b => ({
          type: 'tool_result',
          tool_use_id: b.id,
          content: '',
        })),
      });
    }

    response = await client.messages.create({
      model,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages,
      tools: WEB_SEARCH_TOOLS,
    });
  }

  const textBlock = response.content.find(b => b.type === 'text');
  return textBlock?.text ?? '';
}

// Auth middleware
function authenticate(req, res, next) {
  const key = req.headers['x-relay-key'];
  if (!key || key !== process.env.RELAY_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

app.post('/ask', authenticate, async (req, res) => {
  console.debug('[/ask] headers:', req.headers);
  console.debug('[/ask] raw body:', req.rawBody);
  console.debug('[/ask] parsed body:', req.body);

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

  const models = ['claude-haiku-4-5-20251001', 'claude-sonnet-4-20250514'];

  for (const model of models) {
    try {
      const reply = await runAgenticLoop(model, history);
      insertMessage.run('assistant', reply, source);

      // Convert reply to speech via ElevenLabs
      let audio_base64 = null;
      try {
        const ttsRes = await fetch(
          `https://api.elevenlabs.io/v1/text-to-speech/${process.env.ELEVENLABS_VOICE_ID}`,
          {
            method: 'POST',
            headers: {
              'xi-api-key': process.env.ELEVENLABS_API_KEY,
              'Content-Type': 'application/json',
              Accept: 'audio/mpeg',
            },
            body: JSON.stringify({
              text: reply,
              model_id: 'eleven_turbo_v2',
              output_format: 'mp3_44100_128',
            }),
          }
        );
        if (!ttsRes.ok) {
          const errText = await ttsRes.text();
          console.error(`ElevenLabs error (${ttsRes.status}):`, errText);
        } else {
          const arrayBuf = await ttsRes.arrayBuffer();
          audio_base64 = Buffer.from(arrayBuf).toString('base64');
        }
      } catch (ttsErr) {
        console.error('ElevenLabs fetch error:', ttsErr);
      }

      return res.json({ reply, audio_base64, source, model });
    } catch (err) {
      console.error(`Anthropic API error (${model}):`, err);
      if (model === models.at(-1)) {
        return res.status(502).json({ error: 'Failed to get response from AI' });
      }
    }
  }
});

// Health check
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`JARVIS relay listening on port ${PORT}`);
});
