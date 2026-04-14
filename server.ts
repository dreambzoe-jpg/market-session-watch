// ─── Market Session Watch — Gmail Fundamentals Server ────────────────────────
// Handles server-side Gmail OAuth2 token refresh and email fetching.
// The client_secret and refresh_token stay here, never in the browser bundle.
//
// One-time setup:
//   1. Add http://localhost:3001/auth/callback to your Google Cloud Console
//      (APIs & Services → Credentials → your OAuth 2.0 Client → Authorized redirect URIs)
//   2. Run: npm run server
//   3. Open: http://localhost:3001/auth/setup  — follow the Google login
//   4. Copy the printed GMAIL_REFRESH_TOKEN into your .env
//   5. Restart the server
//
// Dev usage:
//   Terminal 1: npm run server
//   Terminal 2: npm run dev
//   The Vite dev server proxies /api/* → http://localhost:3001

import 'dotenv/config';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';

const app  = express();
// Railway injects PORT automatically; fall back to 3001 for local dev
const PORT = Number(process.env.PORT ?? process.env.SERVER_PORT ?? 3001);

app.use(express.json());

// Allow requests from the Capacitor WebView (https://localhost) and dev server
app.use((_req: Request, res: Response, next: NextFunction) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-zapier-secret, x-make-secret');
  next();
});

const CLIENT_ID          = process.env.VITE_GOOGLE_CLIENT_ID    ?? '';
const CLIENT_SECRET      = process.env.GMAIL_CLIENT_SECRET      ?? '';
const REFRESH_TOKEN      = process.env.GMAIL_REFRESH_TOKEN      ?? '';
const MAKE_WEBHOOK_SECRET = process.env.MAKE_WEBHOOK_SECRET     ?? '';
const MAKE_SCENARIO_URL   = process.env.MAKE_SCENARIO_URL       ?? '';

const SETUP_REDIRECT_URI = `http://localhost:${PORT}/auth/callback`;
const GMAIL_SCOPE        = 'https://www.googleapis.com/auth/gmail.readonly';
const GMAIL_BASE         = 'https://gmail.googleapis.com/gmail/v1';
const TOKEN_URL          = 'https://oauth2.googleapis.com/token';

// ── Token cache (in-memory; refreshed automatically) ──────────────────────────
let cachedAccessToken = '';
let tokenExpiresAt    = 0;

async function getAccessToken(): Promise<string> {
  if (cachedAccessToken && Date.now() < tokenExpiresAt) return cachedAccessToken;

  if (!CLIENT_SECRET || !REFRESH_TOKEN) {
    throw new Error('Server not configured. Set GMAIL_CLIENT_SECRET and GMAIL_REFRESH_TOKEN in .env, then run /auth/setup to get the refresh token.');
  }

  const res = await fetch(TOKEN_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    new URLSearchParams({
      grant_type:    'refresh_token',
      refresh_token: REFRESH_TOKEN,
      client_id:     CLIENT_ID,
      client_secret: CLIENT_SECRET,
    }).toString(),
  });

  const data = await res.json() as Record<string, unknown>;
  if (!res.ok) throw new Error(`Token refresh failed: ${JSON.stringify(data)}`);

  cachedAccessToken = String(data.access_token);
  tokenExpiresAt    = Date.now() + Number(data.expires_in ?? 3600) * 1000 - 60_000;
  return cachedAccessToken;
}

// ── Email body helpers ────────────────────────────────────────────────────────
function decodeBase64Url(encoded: string): string {
  const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(base64, 'base64').toString('utf-8');
}

function stripHtml(html: string): string {
  return html
    // Remove entire <style>, <script>, <head> blocks
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<head[\s\S]*?<\/head>/gi, '')
    // Strip all remaining tags
    .replace(/<[^>]+>/g, ' ')
    // Decode common HTML entities
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#\d+;/gi, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    // Collapse all whitespace (including \r\n) into single spaces
    .replace(/[\s\r\n]+/g, ' ')
    .trim();
}

function extractBody(payload: Record<string, unknown>): string {
  const fromParts = (parts: unknown[]): string => {
    for (const raw of parts) {
      const p = raw as Record<string, unknown>;
      if (p.mimeType === 'text/plain') {
        const b = p.body as Record<string, unknown> | undefined;
        if (b?.data) return decodeBase64Url(b.data as string);
      }
      if (Array.isArray(p.parts)) {
        const sub = fromParts(p.parts);
        if (sub) return sub;
      }
    }
    for (const raw of parts) {
      const p = raw as Record<string, unknown>;
      if (p.mimeType === 'text/html') {
        const b = p.body as Record<string, unknown> | undefined;
        if (b?.data) {
          return stripHtml(decodeBase64Url(b.data as string));
        }
      }
    }
    return '';
  };

  if (Array.isArray(payload.parts)) return fromParts(payload.parts);
  const body = payload.body as Record<string, unknown> | undefined;
  if (body?.data) return stripHtml(decodeBase64Url(body.data as string));
  return '';
}

// ── Bias parsing ──────────────────────────────────────────────────────────────
function parseBias(text: string): 'bullish' | 'bearish' | 'neutral' {
  const lower = text.toLowerCase();

  const bullishPhrases = [
    /\bbullish\b/, /\bupside\b/, /\brise\b/, /\brising\b/, /\buptrend\b/,
    /\blong gold\b/, /\bbuy gold\b/, /\bupward\b/, /\bprice target.{0,20}(?:\$\d{4,}|higher)/,
    /\bsupport holding\b/, /\bbreakout\b/, /\bpositive\b/,
  ];
  const bearishPhrases = [
    /\bbearish\b/, /\bdownside\b/, /\bfall\b/, /\bfalling\b/, /\bdowntrend\b/,
    /\bshort gold\b/, /\bsell gold\b/, /\bdownward\b/, /\bunder pressure\b/,
    /\bresistance\b/, /\bnegative\b/, /\bdecline\b/, /\bdeclining\b/,
  ];

  let bull = 0; let bear = 0;
  bullishPhrases.forEach(p => { if (p.test(lower)) bull++; });
  bearishPhrases.forEach(p => { if (p.test(lower)) bear++; });

  if (bull > bear) return 'bullish';
  if (bear > bull) return 'bearish';
  return 'neutral';
}

function extractSummary(body: string): string {
  // Normalize: collapse all whitespace to single spaces first
  const clean = body.replace(/\s+/g, ' ').trim();

  // Insert paragraph breaks before numbered emoji items (1️⃣, 2️⃣, 3️⃣…)
  const withBreaks = clean
    .replace(/\s*([1-9]️⃣)/g, '\n\n$1')
    .trim();

  // If numbered sections were found, keep only the intro line + numbered paragraphs
  if (withBreaks.includes('\n\n')) {
    const paragraphs = withBreaks.split('\n\n').map(p => p.trim()).filter(Boolean);
    const kept = paragraphs
      .filter((p, i) => i === 0 || /^[1-9]️⃣/.test(p))
      // Strip any boilerplate that got appended inline within a paragraph
      .map(p => {
        // Strip Gmail truncation marker and boilerplate
        const stripped = p
          .replace(/\s+\S{0,8}\s*\.\.\..*/s, '.')
          .replace(/\s*(?:continue reading|read more|unsubscribe|©|\u00a9).*/is, '')
          .trim();
        // For numbered sections: keep only sentences that mention the instrument or bias
        if (/^[1-9]️⃣/.test(stripped)) {
          const relevantKeywords = /gold|xauusd|silver|dxy|dollar|euro|pound|yen|oil|crude|btc|bitcoin|bullish|bearish|neutral|bias|sentiment|reason/i;
          const sentences = stripped.split(/(?<=\.)\s+/);
          const kept = sentences.filter(s => relevantKeywords.test(s));
          return kept.length ? kept.join(' ') : stripped;
        }
        return stripped;
      });
    return kept.join('\n\n');
  }

  // Fallback: pick the most relevant sentences
  const keywords = ['bullish', 'bearish', 'neutral', 'gold', 'xauusd', 'bias',
    'fundamental', 'trend', 'support', 'resistance', 'buy', 'sell'];
  const sentences = clean
    .split(/(?<=[.!?])\s+/)
    .filter(s => s.length > 40 && s.length < 600)
    .filter(s => keywords.some(k => s.toLowerCase().includes(k)));
  return sentences.slice(0, 3).join(' ').trim() || clean.slice(0, 400).trim();
}

// ── Webhook cache ─────────────────────────────────────────────────────────────
// Make.com (or Zapier fallback) POSTs parsed email data here; the GET
// /api/fundamentals endpoint serves this first and only falls back to the
// direct Gmail path if empty.
interface FundamentalsPayload {
  emailId:   string;
  subject:   string;
  date:      string;
  bias:      'bullish' | 'bearish' | 'neutral';
  summary:   string;
  fetchedAt: number;
}
let webhookCache: FundamentalsPayload | null = null;

// ── One-time OAuth setup routes ────────────────────────────────────────────────
app.get('/auth/setup', (_req, res) => {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    res.status(500).send('<h2>Missing VITE_GOOGLE_CLIENT_ID or GMAIL_CLIENT_SECRET in .env</h2>');
    return;
  }
  const params = new URLSearchParams({
    client_id:     CLIENT_ID,
    redirect_uri:  SETUP_REDIRECT_URI,
    response_type: 'code',
    scope:         GMAIL_SCOPE,
    access_type:   'offline',
    prompt:        'consent',
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

app.get('/auth/callback', async (req, res) => {
  const code = req.query['code'] as string | undefined;
  if (!code) {
    res.status(400).send('<h2>No code in callback</h2>');
    return;
  }
  try {
    const tokenRes = await fetch(TOKEN_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    new URLSearchParams({
        grant_type:    'authorization_code',
        code,
        client_id:     CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uri:  SETUP_REDIRECT_URI,
      }).toString(),
    });
    const data = await tokenRes.json() as Record<string, unknown>;

    if (data.refresh_token) {
      console.log('\n✅  Got refresh token:', data.refresh_token);
      res.send(`
        <style>body{font-family:monospace;padding:2rem;background:#111;color:#eee}</style>
        <h2 style="color:#4ade80">✅ Success! Add this to your .env:</h2>
        <pre style="background:#222;padding:1rem;border-radius:8px;border:1px solid #333">GMAIL_REFRESH_TOKEN=${data.refresh_token}</pre>
        <p style="color:#aaa">Restart the server after updating .env. You can close this tab.</p>
      `);
    } else {
      res.send(`
        <style>body{font-family:monospace;padding:2rem;background:#111;color:#eee}</style>
        <h2 style="color:#f87171">No refresh_token returned</h2>
        <pre style="background:#222;padding:1rem;border-radius:8px">${JSON.stringify(data, null, 2)}</pre>
        <p style="color:#aaa">Try opening <a href="/auth/setup" style="color:#60a5fa">/auth/setup</a> again.
        Make sure you haven't already authorized this app (revoke at myaccount.google.com/permissions if needed).</p>
      `);
    }
  } catch (e) {
    res.status(500).send(`<h2>Error</h2><pre>${e}</pre>`);
  }
});

// ── Make.com webhook endpoint ──────────────────────────────────────────────────
// Make.com Scenario setup:
//   Module 1 → Gmail: Watch Emails
//              From: noreply@x.ai  |  Subject contains: XAUUSD
//   Module 2 → HTTP: Make a Request
//              URL     : <your Railway URL>/api/make/hook
//              Method  : POST
//              Headers : x-make-secret → <value of MAKE_WEBHOOK_SECRET in .env>
//              Body    : { "subject": "{{subject}}", "bodyPlain": "{{text}}",
//                          "date": "{{date}}", "messageId": "{{id}}" }
//
// For local dev, expose with:  npx ngrok http 3001
function handleWebhookPost(req: Request, res: Response, secretHeader: string, secretEnvValue: string, platform: string) {
  if (secretEnvValue && req.headers[secretHeader] !== secretEnvValue) {
    res.status(401).json({ error: `Unauthorized — wrong ${secretHeader} header` });
    return;
  }

  const body: Record<string, unknown> = req.body ?? {};
  const emailText = String(body['bodyPlain'] ?? body['body'] ?? body['Body'] ?? '');
  const subject   = String(body['subject']   ?? body['Subject'] ?? 'XAUUSD Analysis');
  const date      = String(body['date']      ?? body['Date']    ?? new Date().toUTCString());
  const emailId   = String(body['messageId'] ?? body['id']      ?? Date.now().toString());

  if (!emailText) {
    res.status(400).json({ error: `No email body received — ensure ${platform} sends bodyPlain or body` });
    return;
  }

  webhookCache = {
    emailId,
    subject,
    date,
    bias:      parseBias(emailText),
    summary:   extractSummary(emailText),
    fetchedAt: Date.now(),
  };

  console.log(`\n📬  ${platform} webhook received — bias: ${webhookCache.bias} (${subject})`);
  res.json({ ok: true, bias: webhookCache.bias });
}

app.post('/api/make/hook', (req: Request, res: Response) => {
  handleWebhookPost(req, res, 'x-make-secret', MAKE_WEBHOOK_SECRET, 'Make.com');
});

// Legacy Zapier path kept for backwards compatibility
app.post('/api/zapier/hook', (req: Request, res: Response) => {
  handleWebhookPost(req, res, 'x-zapier-secret', process.env.ZAPIER_WEBHOOK_SECRET ?? '', 'Zapier');
});

// ── Manual trigger endpoint ────────────────────────────────────────────────────
// The app's refresh button POSTs here. The server fires the Make.com scenario
// webhook URL, which runs the scenario (Watch Emails → POST back to /api/make/hook).
// The app polls /api/fundamentals ~4 s later to pick up the fresh data.
//
// Note: Make.com free tier runs on a schedule (every 15 min), not on-demand.
// To enable on-demand triggering, set MAKE_SCENARIO_URL to the scenario's
// "On-demand" webhook URL from the scenario's settings.
app.post('/api/fundamentals/trigger', async (_req: Request, res: Response) => {
  if (!MAKE_SCENARIO_URL) {
    res.status(503).json({ error: 'MAKE_SCENARIO_URL not configured in .env' });
    return;
  }
  try {
    const makeRes = await fetch(MAKE_SCENARIO_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'market-session-watch', triggeredAt: new Date().toISOString() }),
    });
    if (!makeRes.ok) {
      res.status(502).json({ error: `Make.com returned ${makeRes.status}` });
      return;
    }
    res.json({ triggered: true, message: 'Make.com scenario fired — data will arrive in a few seconds' });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── Main API endpoint ──────────────────────────────────────────────────────────
app.get('/api/fundamentals', async (_req, res) => {
  // ── Webhook cache path (preferred — populated by Make.com or Zapier) ────────
  if (webhookCache) {
    res.json(webhookCache);
    return;
  }

  // ── Direct Gmail path (fallback when Zapier hasn't pushed yet) ───────────
  try {
    const token = await getAccessToken();

    const query     = 'from:noreply@x.ai subject:(XAUUSD OR Gold OR Fundamentals)';
    const searchRes = await fetch(
      `${GMAIL_BASE}/users/me/messages?q=${encodeURIComponent(query)}&maxResults=1`,
      { headers: { Authorization: `Bearer ${token}` } },
    );

    if (!searchRes.ok) {
      const err = await searchRes.json() as Record<string, unknown>;
      res.status(searchRes.status).json({ error: `Gmail search failed: ${JSON.stringify(err)}` });
      return;
    }

    const { messages } = await searchRes.json() as { messages?: { id: string }[] };
    if (!messages?.length) {
      res.status(404).json({ error: 'No matching emails found' });
      return;
    }

    const { id: emailId } = messages[0];
    const msgRes = await fetch(
      `${GMAIL_BASE}/users/me/messages/${emailId}?format=full`,
      { headers: { Authorization: `Bearer ${token}` } },
    );

    if (!msgRes.ok) {
      res.status(msgRes.status).json({ error: `Gmail fetch failed: ${msgRes.status}` });
      return;
    }

    const msg  = await msgRes.json() as Record<string, unknown>;
    const payload = (msg.payload ?? {}) as Record<string, unknown>;
    const hdrs: { name: string; value: string }[] = (payload.headers as never[]) ?? [];
    const subject = hdrs.find(h => h.name === 'Subject')?.value ?? 'XAUUSD Analysis';
    const date    = hdrs.find(h => h.name === 'Date')?.value    ?? '';
    const body    = extractBody(payload);

    res.json({
      emailId,
      subject,
      date,
      bias:      parseBias(body),
      summary:   extractSummary(body),
      fetchedAt: Date.now(),
    });
  } catch (e) {
    const msg = String(e);
    const status = msg.includes('not configured') ? 503 : 500;
    res.status(status).json({ error: msg.replace('Error: ', '') });
  }
});

// ── Privacy policy (served for Google Play Store) ─────────────────────────────
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

app.get('/privacy-policy', (_req, res) => {
  try {
    const dir = typeof __dirname !== 'undefined' ? __dirname : dirname(fileURLToPath(import.meta.url));
    const html = readFileSync(join(dir, 'privacy-policy.html'), 'utf-8');
    res.type('html').send(html);
  } catch {
    res.status(404).send('Privacy policy not found');
  }
});

app.listen(PORT, () => {
  console.log(`\n🟢  Fundamentals server running on http://localhost:${PORT}`);
  if (!REFRESH_TOKEN) {
    console.log(`\n⚠️  GMAIL_REFRESH_TOKEN not set.`);
    console.log(`    1. Add http://localhost:${PORT}/auth/callback to Google Cloud Console`);
    console.log(`       (Credentials → your OAuth client → Authorized redirect URIs)`);
    console.log(`    2. Open http://localhost:${PORT}/auth/setup in your browser\n`);
  }
});
