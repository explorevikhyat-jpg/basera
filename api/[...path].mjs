import { randomUUID, createHmac, timingSafeEqual } from 'node:crypto';
import { neon } from '@neondatabase/serverless';

const OTP_TTL_MS = 5 * 60_000;
const SESSION_TTL_MS = 7 * 24 * 60 * 60_000;
let sqlClient;
let schemaReady;

function response(res, status, data) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
  res.end(status === 204 ? '' : JSON.stringify(data));
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 2_000_000) throw Object.assign(new Error('Request too large'), { status: 413 });
  }
  return raw ? JSON.parse(raw) : {};
}

function getSql() {
  if (!process.env.DATABASE_URL) throw Object.assign(new Error('Set DATABASE_URL in Vercel project environment variables.'), { status: 503 });
  sqlClient ||= neon(process.env.DATABASE_URL);
  return sqlClient;
}

async function ensureSchema(sql) {
  schemaReady ||= (async () => {
    await sql`CREATE TABLE IF NOT EXISTS basera_accounts (
      phone text PRIMARY KEY, name text NOT NULL, role text NOT NULL CHECK (role IN ('customer','lister')),
      persona text NOT NULL CHECK (persona IN ('student','professional')),
      subscription_active boolean NOT NULL DEFAULT false, plan text, created_at timestamptz NOT NULL DEFAULT now()
    )`;
    await sql`CREATE TABLE IF NOT EXISTS basera_properties (
      id uuid PRIMARY KEY, owner_phone text NOT NULL REFERENCES basera_accounts(phone), data jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )`;
    await sql`CREATE TABLE IF NOT EXISTS basera_posts (
      id uuid PRIMARY KEY, data jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
    )`;
    await sql`CREATE TABLE IF NOT EXISTS basera_otp_rate_limits (
      phone text PRIMARY KEY, last_sent_at timestamptz NOT NULL, window_started_at timestamptz NOT NULL, sends integer NOT NULL
    )`;
    await sql`CREATE TABLE IF NOT EXISTS basera_revoked_sessions (
      jti uuid PRIMARY KEY, expires_at timestamptz NOT NULL
    )`;
  })();
  return schemaReady;
}

function secret() {
  if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) {
    throw Object.assign(new Error('Set SESSION_SECRET to a random value of at least 32 characters.'), { status: 503 });
  }
  return process.env.SESSION_SECRET;
}

function signedToken(payload) {
  const value = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', secret()).update(value).digest('base64url');
  return `${value}.${sig}`;
}

function readSignedToken(value) {
  if (!value) return null;
  const [encoded, sig] = value.split('.');
  if (!encoded || !sig) return null;
  const expected = createHmac('sha256', secret()).update(encoded).digest();
  const received = Buffer.from(sig, 'base64url');
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString());
  return payload.exp > Date.now() ? payload : null;
  } catch { return null; }
}

async function currentAccount(req, sql) {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  const payload = readSignedToken(token);
  if (payload?.purpose !== 'session' || !payload.phone) return null;
  if (!payload.jti) return null;
  const rows = await sql`SELECT a.phone, a.name, a.role, a.persona, a.subscription_active, a.plan
    FROM basera_accounts a WHERE a.phone = ${payload.phone}
    AND NOT EXISTS (SELECT 1 FROM basera_revoked_sessions r WHERE r.jti = ${payload.jti}::uuid)`;
  return rows[0] || null;
}

function publicAccount(account) {
  return { phone: account.phone, name: account.name, role: account.role, persona: account.persona, subscriptionActive: account.subscription_active, plan: account.plan };
}

function twilioConfig() {
  const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_VERIFY_SERVICE_SID } = process.env;
  return TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && TWILIO_VERIFY_SERVICE_SID ? { accountSid: TWILIO_ACCOUNT_SID, authToken: TWILIO_AUTH_TOKEN, serviceSid: TWILIO_VERIFY_SERVICE_SID } : null;
}

async function twilioVerify(path, params) {
  const cfg = twilioConfig();
  if (!cfg) throw Object.assign(new Error('SMS verification is not configured. Add the Twilio Verify environment variables in Vercel.'), { status: 503 });
  const url = `https://verify.twilio.com/v2/Services/${cfg.serviceSid}/${path}`;
  const result = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Basic ${Buffer.from(`${cfg.accountSid}:${cfg.authToken}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  const data = await result.json().catch(() => ({}));
  if (!result.ok) {
    if (path === 'VerificationCheck' && result.status === 404) return { status: 'invalid' };
    throw Object.assign(new Error(result.status === 429 ? 'Too many code requests. Wait before trying again.' : 'SMS verification is temporarily unavailable.'), { status: result.status === 429 ? 429 : 502 });
  }
  return data;
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return response(res, 204, {});
  try {
    const sql = getSql();
    await ensureSchema(sql);
    const path = new URL(req.url, `https://${req.headers.host || 'localhost'}`).pathname;

    if (req.method === 'GET' && path === '/api/health') return response(res, 200, { ok: true });

    if (req.method === 'POST' && path === '/api/auth/otp') {
      const { phone, mode, role, persona } = await readBody(req);
      if (!/^\+\d{10,15}$/.test(String(phone || ''))) return response(res, 400, { error: 'Enter a valid phone number.' });
      if (mode !== 'login' && mode !== 'signup') return response(res, 400, { error: 'Choose log in or sign up.' });
      const normalizedRole = role === 'lister' ? 'lister' : 'customer';
      const normalizedPersona = persona === 'professional' ? 'professional' : 'student';
      const rows = await sql`SELECT phone, name, role, persona FROM basera_accounts WHERE phone = ${phone}`;
      const existing = rows[0];
      if (mode === 'signup' && existing) return response(res, 409, { error: 'An account with this number already exists — log in instead.' });
      if (mode === 'login' && !existing) return response(res, 404, { error: 'No account found with this number — sign up instead.' });
      if (existing && (existing.role !== normalizedRole || existing.persona !== normalizedPersona)) {
        return response(res, 403, { error: `This number is registered as ${existing.role === 'lister' ? 'Owner' : 'Tenant'} · ${existing.persona === 'professional' ? 'Professional' : 'Student'}. Choose that option above to log in.` });
      }
      secret();
      const limits = await sql`INSERT INTO basera_otp_rate_limits (phone, last_sent_at, window_started_at, sends)
        VALUES (${phone}, now(), now(), 1)
        ON CONFLICT (phone) DO UPDATE SET
          last_sent_at = now(),
          window_started_at = CASE WHEN basera_otp_rate_limits.window_started_at < now() - interval '1 hour' THEN now() ELSE basera_otp_rate_limits.window_started_at END,
          sends = CASE WHEN basera_otp_rate_limits.window_started_at < now() - interval '1 hour' THEN 1 ELSE basera_otp_rate_limits.sends + 1 END
        WHERE basera_otp_rate_limits.last_sent_at < now() - interval '30 seconds'
          AND (basera_otp_rate_limits.window_started_at < now() - interval '1 hour' OR basera_otp_rate_limits.sends < 5)
        RETURNING phone`;
      if (!limits.length) return response(res, 429, { error: 'Please wait before requesting another code. You can request up to five codes per hour.' });
      await twilioVerify('Verifications', { To: phone, Channel: 'sms' });
      const challenge = signedToken({ purpose: 'otp', phone, mode, role: normalizedRole, persona: normalizedPersona, exp: Date.now() + OTP_TTL_MS });
      return response(res, 200, { expiresAt: Date.now() + OTP_TTL_MS, challenge, delivery: 'sms' });
    }

    if (req.method === 'POST' && path === '/api/auth/verify') {
      const { phone, code, challenge, name } = await readBody(req);
      const ticket = readSignedToken(challenge);
      if (!ticket || ticket.purpose !== 'otp' || ticket.phone !== phone) return response(res, 400, { error: 'This code request expired. Request a new one.' });
      const checked = await twilioVerify('VerificationCheck', { To: phone, Code: String(code || '') });
      if (checked.status !== 'approved') return response(res, 400, { error: 'Incorrect, expired, or already used code. Please try again or request a new one.' });
      let account;
      if (ticket.mode === 'signup') {
        if (!String(name || '').trim()) return response(res, 400, { error: 'Enter your name.' });
        const rows = await sql`INSERT INTO basera_accounts (phone, name, role, persona)
          VALUES (${phone}, ${String(name).trim().slice(0, 100)}, ${ticket.role}, ${ticket.persona})
          ON CONFLICT (phone) DO NOTHING
          RETURNING phone, name, role, persona, subscription_active, plan`;
        account = rows[0];
        if (!account) return response(res, 409, { error: 'An account with this number already exists — log in instead.' });
      } else {
        const rows = await sql`SELECT phone, name, role, persona, subscription_active, plan FROM basera_accounts WHERE phone = ${phone}`;
        account = rows[0];
        if (!account) return response(res, 404, { error: 'No account found with this number — sign up instead.' });
        if (account.role !== ticket.role || account.persona !== ticket.persona) return response(res, 403, { error: 'Your account type changed. Request a new code using the registered account type.' });
      }
      return response(res, 200, { token: signedToken({ purpose: 'session', phone, jti: randomUUID(), exp: Date.now() + SESSION_TTL_MS }), account: publicAccount(account) });
    }

    const account = await currentAccount(req, sql);
    if (!account) return response(res, 401, { error: 'Sign in required.' });
    if (req.method === 'GET' && path === '/api/me') return response(res, 200, { account: publicAccount(account) });
    if (req.method === 'POST' && path === '/api/auth/logout') {
      const token = readSignedToken(req.headers.authorization?.replace(/^Bearer\s+/i, ''));
      if (token?.jti) await sql`INSERT INTO basera_revoked_sessions (jti, expires_at) VALUES (${token.jti}::uuid, to_timestamp(${token.exp} / 1000.0)) ON CONFLICT (jti) DO NOTHING`;
      return response(res, 200, { ok: true });
    }

    if (req.method === 'GET' && path === '/api/properties') {
      const rows = await sql`SELECT data FROM basera_properties ORDER BY created_at DESC`;
      return response(res, 200, { properties: rows.map((row) => row.data) });
    }
    if (req.method === 'POST' && path === '/api/properties') {
      if (account.role !== 'lister' || !account.subscription_active) return response(res, 403, { error: 'An active owner subscription is required to publish listings.' });
      const input = await readBody(req);
      const candidates = Array.isArray(input.tenantFor) ? input.tenantFor : input.tenantFor === 'any' || !input.tenantFor ? ['students', 'professionals'] : [input.tenantFor];
      const tenantFor = [...new Set(candidates.filter((item) => item === 'students' || item === 'professionals'))];
      if (!tenantFor.length) return response(res, 400, { error: 'Choose at least one renter category for this listing.' });
      const id = randomUUID();
      const listing = { ...input, tenantFor, id, ownerPhone: account.phone, ownerName: account.name, status: 'pending', premium: false, reviews: [] };
      await sql`INSERT INTO basera_properties (id, owner_phone, data) VALUES (${id}, ${account.phone}, ${JSON.stringify(listing)}::jsonb)`;
      return response(res, 201, { listing });
    }

    const property = path.match(/^\/api\/properties\/([0-9a-f-]+)(?:\/(review|verify|boost))?$/i);
    if (property && req.method === 'PATCH') {
      const [row] = await sql`SELECT data, owner_phone FROM basera_properties WHERE id = ${property[1]}::uuid`;
      if (!row) return response(res, 404, { error: 'Listing not found.' });
      const listing = row.data;
      const action = property[2];
      if (action === 'review') {
        if (account.role !== 'customer') return response(res, 403, { error: 'Only tenants can review listings.' });
        const input = await readBody(req);
        if (!(input.rating >= 1 && input.rating <= 5) || !String(input.text || '').trim()) return response(res, 400, { error: 'A rating and review are required.' });
        listing.reviews = Array.isArray(listing.reviews) ? listing.reviews : [];
        listing.reviews.unshift({ id: randomUUID(), author: account.name, rating: input.rating, text: String(input.text).slice(0, 1500), date: new Date().toLocaleDateString('en-IN', { month: 'short', year: 'numeric' }) });
      } else {
        if (account.role !== 'lister' || row.owner_phone !== account.phone) return response(res, 403, { error: 'Only the listing owner can update it.' });
        if (action === 'verify') listing.status = 'verified';
        if (action === 'boost') listing.premium = true;
      }
      await sql`UPDATE basera_properties SET data = ${JSON.stringify(listing)}::jsonb WHERE id = ${property[1]}::uuid`;
      return response(res, 200, { listing });
    }

    if (req.method === 'POST' && path === '/api/subscription') {
      const { plan, price } = await readBody(req);
      if (!plan) return response(res, 400, { error: 'Select a plan.' });
      const rows = await sql`UPDATE basera_accounts SET subscription_active = true, plan = ${String(plan).slice(0, 100)} WHERE phone = ${account.phone}
        RETURNING phone, name, role, persona, subscription_active, plan`;
      return response(res, 200, { account: publicAccount(rows[0]), price: Number(price) || 0 });
    }
    if (req.method === 'GET' && path === '/api/posts') {
      const rows = await sql`SELECT data FROM basera_posts ORDER BY created_at DESC`;
      return response(res, 200, { posts: rows.map((row) => row.data) });
    }
    if (req.method === 'POST' && path === '/api/posts') {
      const input = await readBody(req);
      if (!String(input.text || '').trim()) return response(res, 400, { error: 'Post text is required.' });
      const id = randomUUID();
      const post = { id, author: account.name, tag: String(input.tag || 'General').slice(0, 40), text: String(input.text).trim().slice(0, 1500), date: 'Just now', likes: 0 };
      await sql`INSERT INTO basera_posts (id, data) VALUES (${id}, ${JSON.stringify(post)}::jsonb)`;
      return response(res, 201, { post });
    }
    const like = path.match(/^\/api\/posts\/([0-9a-f-]+)\/like$/i);
    if (like && req.method === 'POST') {
      const rows = await sql`UPDATE basera_posts SET data = jsonb_set(data, '{likes}', to_jsonb(COALESCE((data->>'likes')::integer, 0) + 1)) WHERE id = ${like[1]}::uuid RETURNING data`;
      return rows[0] ? response(res, 200, { post: rows[0].data }) : response(res, 404, { error: 'Post not found.' });
    }
    return response(res, 404, { error: 'Not found.' });
  } catch (error) {
    console.error('Basera API error:', error);
    return response(res, error.status || 500, { error: error.status ? error.message : 'Internal server error.' });
  }
}
