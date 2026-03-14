import express from 'express';
import Database from 'better-sqlite3';
import Anthropic from '@anthropic-ai/sdk';
import { google } from 'googleapis';
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

// Google Calendar
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET
);
oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

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

const TOOLS = [
  { type: 'web_search_20250305', name: 'web_search' },
  {
    name: 'get_calendar_events',
    description: 'Get Google Calendar events for a date range.',
    input_schema: {
      type: 'object',
      properties: {
        start_date: { type: 'string', description: 'Start date in YYYY-MM-DD format' },
        end_date:   { type: 'string', description: 'End date in YYYY-MM-DD format' },
      },
      required: ['start_date', 'end_date'],
    },
  },
  {
    name: 'create_calendar_event',
    description: 'Create a new Google Calendar event.',
    input_schema: {
      type: 'object',
      properties: {
        title:          { type: 'string', description: 'Event title' },
        start_datetime: { type: 'string', description: 'Start datetime in ISO 8601 format' },
        end_datetime:   { type: 'string', description: 'End datetime in ISO 8601 format' },
        description:    { type: 'string', description: 'Optional event description' },
      },
      required: ['title', 'start_datetime', 'end_datetime'],
    },
  },
  {
    name: 'get_todays_events',
    description: "Get all of today's Google Calendar events.",
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'create_reminder',
    description: 'Create a calendar reminder event at a specific time.',
    input_schema: {
      type: 'object',
      properties: {
        title:    { type: 'string', description: 'Reminder title' },
        datetime: { type: 'string', description: 'Reminder datetime in ISO 8601 format' },
      },
      required: ['title', 'datetime'],
    },
  },
];

// ── Calendar tool implementations ────────────────────────────────────────────

function toISOStart(dateStr) {
  return new Date(`${dateStr}T00:00:00`).toISOString();
}
function toISOEnd(dateStr) {
  return new Date(`${dateStr}T23:59:59`).toISOString();
}
function formatEvent(e) {
  return {
    id:          e.id,
    title:       e.summary,
    start:       e.start.dateTime ?? e.start.date,
    end:         e.end.dateTime   ?? e.end.date,
    description: e.description ?? '',
  };
}

async function calendarGetEvents({ start_date, end_date }) {
  const res = await calendar.events.list({
    calendarId:   'primary',
    timeMin:      toISOStart(start_date),
    timeMax:      toISOEnd(end_date),
    singleEvents: true,
    orderBy:      'startTime',
  });
  return (res.data.items ?? []).map(formatEvent);
}

async function calendarCreateEvent({ title, start_datetime, end_datetime, description }) {
  const res = await calendar.events.insert({
    calendarId:  'primary',
    requestBody: {
      summary:     title,
      description: description ?? '',
      start: { dateTime: new Date(start_datetime).toISOString() },
      end:   { dateTime: new Date(end_datetime).toISOString() },
    },
  });
  return { id: res.data.id, title: res.data.summary, link: res.data.htmlLink };
}

async function calendarGetTodaysEvents() {
  const now = new Date();
  const start = new Date(now); start.setHours(0, 0, 0, 0);
  const end   = new Date(now); end.setHours(23, 59, 59, 999);
  const res = await calendar.events.list({
    calendarId:   'primary',
    timeMin:      start.toISOString(),
    timeMax:      end.toISOString(),
    singleEvents: true,
    orderBy:      'startTime',
  });
  return (res.data.items ?? []).map(formatEvent);
}

async function calendarCreateReminder({ title, datetime }) {
  const start = new Date(datetime);
  const end   = new Date(start.getTime() + 30 * 60 * 1000);
  const res = await calendar.events.insert({
    calendarId:  'primary',
    requestBody: {
      summary: title,
      start:   { dateTime: start.toISOString() },
      end:     { dateTime: end.toISOString() },
      reminders: {
        useDefault: false,
        overrides:  [{ method: 'popup', minutes: 0 }],
      },
    },
  });
  return { id: res.data.id, title: res.data.summary, link: res.data.htmlLink };
}

async function executeCalendarTool(name, input) {
  switch (name) {
    case 'get_calendar_events':  return calendarGetEvents(input);
    case 'create_calendar_event': return calendarCreateEvent(input);
    case 'get_todays_events':    return calendarGetTodaysEvents();
    case 'create_reminder':      return calendarCreateReminder(input);
    default: return { error: `Unknown tool: ${name}` };
  }
}

const VOICE_SOURCES = new Set(['siri', 'alexa']);
const CLAUDE_TIMEOUT_MS = 25_000;
const TIMEOUT_REPLY = "I'm sorry, that took too long. Please try again.";

// Run the Claude agentic loop with web search, returning the final text reply.
async function runAgenticLoop(model, history, source) {
  const messages = [...history];
  const systemPrompt = VOICE_SOURCES.has(source)
    ? `${SYSTEM_PROMPT} For voice responses keep answers under 4 sentences. Be direct and concise.`
    : SYSTEM_PROMPT;

  let response = await client.messages.create({
    model,
    max_tokens: 1024,
    system: systemPrompt,
    messages,
    tools: TOOLS,
  });

  while (response.stop_reason === 'tool_use') {
    console.debug('[agentic] tool_use round, content:', JSON.stringify(response.content));

    messages.push({ role: 'assistant', content: response.content });

    // Server-side tools (web_search) return pre-populated tool_result blocks.
    // Client-side tools (calendar) return tool_use blocks we must execute.
    const prePopulated = response.content.filter(b => b.type === 'tool_result');
    const prePopulatedIds = new Set(prePopulated.map(b => b.tool_use_id));

    const clientSideUse = response.content.filter(
      b => b.type === 'tool_use' && !prePopulatedIds.has(b.id)
    );

    const clientSideResults = await Promise.all(
      clientSideUse.map(async b => {
        console.debug(`[agentic] executing tool: ${b.name}`, b.input);
        try {
          const result = await executeCalendarTool(b.name, b.input);
          return { type: 'tool_result', tool_use_id: b.id, content: JSON.stringify(result) };
        } catch (err) {
          console.error(`[agentic] tool error (${b.name}):`, err);
          return { type: 'tool_result', tool_use_id: b.id, content: JSON.stringify({ error: err.message }) };
        }
      })
    );

    messages.push({ role: 'user', content: [...prePopulated, ...clientSideResults] });

    response = await client.messages.create({
      model,
      max_tokens: 1024,
      system: systemPrompt,
      messages,
      tools: TOOLS,
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
      const timeout = new Promise(resolve =>
        setTimeout(() => resolve(TIMEOUT_REPLY), CLAUDE_TIMEOUT_MS)
      );
      const reply = await Promise.race([runAgenticLoop(model, history, source), timeout]);
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
