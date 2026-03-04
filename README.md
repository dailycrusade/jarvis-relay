# JARVIS Relay Server

A lightweight Express server that authenticates clients, maintains SQLite-backed conversation history, and proxies requests to the Anthropic API as JARVIS.

## Requirements

- Node.js 20+
- An [Anthropic API key](https://console.anthropic.com)

## Setup

```bash
# 1. Install dependencies
npm install

# 2. Create your environment file
cp .env.example .env
# Edit .env and fill in ANTHROPIC_API_KEY and RELAY_SECRET

# 3. Start the server
npm start

# Development (auto-restarts on file changes — Node 20+ built-in)
npm run dev
```

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | Yes | Your Anthropic API key |
| `RELAY_SECRET` | Yes | Shared secret clients send via `x-relay-key` header |
| `PORT` | No | Listening port (default `3000`) |

## API

### `POST /ask`

Send a message and receive a JARVIS reply.

**Headers**
```
Content-Type: application/json
x-relay-key: <your RELAY_SECRET>
```

**Body**
```json
{
  "query": "What's on my schedule today?",
  "source": "ios-shortcut"
}
```

**Response**
```json
{
  "reply": "You have three meetings and a dentist appointment at 2 PM.",
  "source": "ios-shortcut"
}
```

**Error responses**

| Status | Meaning |
|---|---|
| `400` | Missing or invalid `query` / `source` |
| `401` | Missing or wrong `x-relay-key` |
| `502` | Anthropic API call failed |

### `GET /health`

Returns `{ "status": "ok" }` — useful for uptime monitoring.

## Conversation history

All messages are stored in `conversations.db` (SQLite, auto-created on first run). The last 20 messages are sent to the model as context on every request, giving JARVIS short-term memory across different clients.

## Security notes

- Keep `RELAY_SECRET` long and random (e.g. `openssl rand -hex 32`).
- Run behind a reverse proxy (nginx, Caddy) with TLS in production.
- `conversations.db` is excluded from git — back it up separately if you care about history.
