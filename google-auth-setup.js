/**
 * One-time Google OAuth setup script.
 *
 * Usage:
 *   node google-auth-setup.js <client_id> <client_secret>
 *
 * Starts a temporary server on port 3000, opens the Google consent
 * page in your browser, catches the callback, and prints the refresh token.
 */

import { google } from 'googleapis';
import express from 'express';
import { exec } from 'child_process';

const REDIRECT_URI = 'http://localhost:3000/oauth/callback';
const SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
];

const [clientId, clientSecret] = process.argv.slice(2);

if (!clientId || !clientSecret) {
  console.error('Usage: node google-auth-setup.js <client_id> <client_secret>');
  process.exit(1);
}

const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, REDIRECT_URI);

const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  prompt: 'consent',
  scope: SCOPES,
});

const app = express();

app.get('/oauth/callback', async (req, res) => {
  const { code, error } = req.query;

  if (error) {
    res.send(`<pre>OAuth error: ${error}</pre>`);
    server.close();
    process.exit(1);
  }

  try {
    const { tokens } = await oauth2Client.getToken(code);
    res.send('<p>Authorization complete. You can close this tab.</p>');
    console.log('\nRefresh token:\n');
    console.log(tokens.refresh_token);
    console.log('\nFull token response (save somewhere safe):\n');
    console.log(JSON.stringify(tokens, null, 2));
  } catch (err) {
    res.send(`<pre>Token exchange failed: ${err.message}</pre>`);
    console.error('Token exchange error:', err);
  } finally {
    server.close();
  }
});

const server = app.listen(3000, () => {
  console.log('Opening Google OAuth consent page…');
  const open =
    process.platform === 'darwin' ? 'open' :
    process.platform === 'win32' ? 'start' : 'xdg-open';
  exec(`${open} "${authUrl}"`);
  console.log('\nIf the browser did not open, visit:\n', authUrl);
});
