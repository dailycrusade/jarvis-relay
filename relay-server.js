import express from 'express';
import Database from 'better-sqlite3';
import Anthropic from '@anthropic-ai/sdk';
import { google } from 'googleapis';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import dotenv from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));

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
const calendar = google.calendar({ version: 'v3', auth: oauth2Client, timeZone: 'America/Chicago' });
const gmail   = google.gmail({ version: 'v1', auth: oauth2Client });

const SYSTEM_PROMPT =
  'You are JARVIS, a personal AI assistant. Be concise and warm. ' +
  'Keep voice responses under 3 sentences unless detail is requested. ' +
  'Never use markdown formatting in responses. ' +
  'Write in plain conversational text suitable for text-to-speech. ' +
  'The user is in the Central Time zone (America/Chicago). ' +
  'When creating calendar events always use America/Chicago timezone. ' +
  'When told a time like 1PM assume it means 1PM Central.';

// Initialize DB
db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    role      TEXT    NOT NULL,
    content   TEXT    NOT NULL,
    source    TEXT    NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS tool_states (
    tool    TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL DEFAULT 1
  );
`);

const insertMessage = db.prepare(
  'INSERT INTO messages (role, content, source) VALUES (?, ?, ?)'
);

const getRecentMessages = db.prepare(
  'SELECT role, content FROM messages ORDER BY id DESC LIMIT 20'
);

// Tool state helpers
const initToolState  = db.prepare('INSERT OR IGNORE INTO tool_states (tool, enabled) VALUES (?, 1)');
const getToolStateDb = db.prepare('SELECT enabled FROM tool_states WHERE tool = ?');
const setToolStateDb = db.prepare('UPDATE tool_states SET enabled = ? WHERE tool = ?');

for (const t of ['gmail', 'calendar', 'web_search']) initToolState.run(t);

function isToolEnabled(category) {
  return getToolStateDb.get(category)?.enabled !== 0;
}

// Map individual tool names → category
const TOOL_CATEGORY = {
  web_search:           'web_search',
  get_calendar_events:  'calendar',
  create_calendar_event:'calendar',
  get_todays_events:    'calendar',
  create_reminder:      'calendar',
  list_calendars:       'calendar',
  get_unread_emails:    'gmail',
  search_emails:        'gmail',
  get_email:            'gmail',
  send_email:           'gmail',
};

function getEnabledTools() {
  return TOOLS.filter(t => isToolEnabled(TOOL_CATEGORY[t.name] ?? t.name));
}

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
  {
    name: 'list_calendars',
    description: 'List all Google Calendars the user has access to.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_unread_emails',
    description: 'Get the latest unread emails from Gmail.',
    input_schema: {
      type: 'object',
      properties: {
        max_results: { type: 'number', description: 'Max emails to return (default 5)' },
      },
    },
  },
  {
    name: 'search_emails',
    description: 'Search Gmail using a query string (same syntax as the Gmail search box).',
    input_schema: {
      type: 'object',
      properties: {
        query:       { type: 'string', description: 'Gmail search query' },
        max_results: { type: 'number', description: 'Max emails to return (default 5)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_email',
    description: 'Get the full content of a specific email by ID.',
    input_schema: {
      type: 'object',
      properties: {
        email_id: { type: 'string', description: 'Gmail message ID' },
      },
      required: ['email_id'],
    },
  },
  {
    name: 'send_email',
    description: 'Send an email on behalf of the user.',
    input_schema: {
      type: 'object',
      properties: {
        to:      { type: 'string', description: 'Recipient email address' },
        subject: { type: 'string', description: 'Email subject' },
        body:    { type: 'string', description: 'Plain text email body' },
      },
      required: ['to', 'subject', 'body'],
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
      start: { dateTime: new Date(start_datetime).toISOString(), timeZone: 'America/Chicago' },
      end:   { dateTime: new Date(end_datetime).toISOString(),   timeZone: 'America/Chicago' },
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
      start:   { dateTime: start.toISOString(), timeZone: 'America/Chicago' },
      end:     { dateTime: end.toISOString(),   timeZone: 'America/Chicago' },
      reminders: {
        useDefault: false,
        overrides:  [{ method: 'popup', minutes: 0 }],
      },
    },
  });
  return { id: res.data.id, title: res.data.summary, link: res.data.htmlLink };
}

async function calendarListCalendars() {
  const res = await calendar.calendarList.list();
  return (res.data.items ?? []).map(c => ({
    id:         c.id,
    summary:    c.summary,
    accessRole: c.accessRole,
    primary:    c.primary ?? false,
  }));
}

// ── Gmail tool implementations ────────────────────────────────────────────────

function decodeBase64url(data) {
  return Buffer.from(data, 'base64url').toString('utf-8');
}

function getHeader(headers, name) {
  return headers?.find(h => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';
}

function extractEmailBody(payload) {
  if (!payload) return '';
  if (payload.body?.data) return decodeBase64url(payload.body.data);
  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body?.data) {
        return decodeBase64url(part.body.data);
      }
    }
    for (const part of payload.parts) {
      const body = extractEmailBody(part);
      if (body) return body;
    }
  }
  return '';
}

async function fetchEmailSummaries(query, maxResults) {
  const listRes = await gmail.users.messages.list({ userId: 'me', q: query, maxResults });
  const messages = listRes.data.messages ?? [];
  return Promise.all(
    messages.map(async m => {
      const msg = await gmail.users.messages.get({
        userId: 'me', id: m.id, format: 'metadata',
        metadataHeaders: ['From', 'Subject', 'Date'],
      });
      const h = msg.data.payload?.headers ?? [];
      return {
        id:      m.id,
        from:    getHeader(h, 'From'),
        subject: getHeader(h, 'Subject'),
        date:    getHeader(h, 'Date'),
        snippet: msg.data.snippet ?? '',
      };
    })
  );
}

async function gmailGetUnreadEmails({ max_results = 5 }) {
  return fetchEmailSummaries('is:unread', max_results);
}

async function gmailSearchEmails({ query, max_results = 5 }) {
  return fetchEmailSummaries(query, max_results);
}

async function gmailGetEmail({ email_id }) {
  const msg = await gmail.users.messages.get({ userId: 'me', id: email_id, format: 'full' });
  const h = msg.data.payload?.headers ?? [];
  return {
    id:      email_id,
    from:    getHeader(h, 'From'),
    subject: getHeader(h, 'Subject'),
    date:    getHeader(h, 'Date'),
    body:    extractEmailBody(msg.data.payload).slice(0, 2000),
  };
}

async function gmailSendEmail({ to, subject, body }) {
  const raw = Buffer.from(
    `To: ${to}\nSubject: ${subject}\nContent-Type: text/plain; charset=utf-8\n\n${body}`
  ).toString('base64url');
  const res = await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
  return { id: res.data.id, status: 'sent' };
}

// ── Tool dispatcher ───────────────────────────────────────────────────────────

async function executeTool(name, input) {
  const category = TOOL_CATEGORY[name];
  if (category && !isToolEnabled(category)) {
    return { disabled: true, message: `The ${category} tool is currently disabled.` };
  }
  switch (name) {
    case 'get_calendar_events':   return calendarGetEvents(input);
    case 'create_calendar_event': return calendarCreateEvent(input);
    case 'get_todays_events':     return calendarGetTodaysEvents();
    case 'create_reminder':       return calendarCreateReminder(input);
    case 'list_calendars':        return calendarListCalendars();
    case 'get_unread_emails':     return gmailGetUnreadEmails(input);
    case 'search_emails':         return gmailSearchEmails(input);
    case 'get_email':             return gmailGetEmail(input);
    case 'send_email':            return gmailSendEmail(input);
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

  const enabledTools = getEnabledTools();

  let response = await client.messages.create({
    model,
    max_tokens: 1024,
    system: systemPrompt,
    messages,
    tools: enabledTools,
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
          const result = await executeTool(b.name, b.input);
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
      tools: enabledTools,
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

      // Strip markdown before sending to TTS
      const ttsText = reply
        .replace(/#{1,6}\s*/g, '')           // # headers
        .replace(/\*\*(.+?)\*\*/g, '$1')     // **bold**
        .replace(/\*(.+?)\*/g, '$1')         // *italic*
        .replace(/_(.+?)_/g, '$1')           // _italic_
        .replace(/^\s*[-•]\s+/gm, '')        // bullet points
        .replace(/^\s*(\d+)\.\s+/gm, '$1. ') // normalise numbered lists
        .trim();

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
              text: ttsText,
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

// ── Admin routes ──────────────────────────────────────────────────────────────

function adminAuth(req, res, next) {
  const key = req.headers['x-admin-key'];
  if (!key || key !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// Serve the admin UI (no auth — the page itself requires the key for API calls)
app.get('/admin', (_req, res) => {
  res.sendFile(join(__dirname, 'admin.html'));
});

app.get('/admin/status', adminAuth, (_req, res) => {
  const states = {};
  for (const t of ['gmail', 'calendar', 'web_search']) {
    states[t] = isToolEnabled(t);
  }
  res.json(states);
});

app.post('/admin/toggle', adminAuth, (req, res) => {
  const { tool } = req.body;
  if (!['gmail', 'calendar', 'web_search'].includes(tool)) {
    return res.status(400).json({ error: 'Invalid tool name' });
  }
  const current = isToolEnabled(tool);
  setToolStateDb.run(current ? 0 : 1, tool);
  res.json({ tool, enabled: !current });
});

// Health check
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`JARVIS relay listening on port ${PORT}`);
});
