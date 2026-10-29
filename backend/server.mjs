import { createServer } from 'node:http';
import { randomInt, randomUUID, createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const PORT = Number(process.env.PORT || 3001);
const DB_FILE = resolve(process.env.BASERA_DB_FILE || './backend/data.json');
const OTP_DEV_MODE = process.env.OTP_DEV_MODE === 'true' || process.argv.includes('--demo');
const OTP_TTL = 5 * 60_000;
const SESSION_TTL = 7 * 24 * 60 * 60_000;
const SESSION_SECRET = process.env.SESSION_SECRET || (OTP_DEV_MODE ? 'local-only-demo-session-secret' : '');
if (!SESSION_SECRET) throw new Error('SESSION_SECRET is required. Set a long random value in the environment.');
const otps = new Map();
const otpSendLimits = new Map();
const hash = (v) => createHash('sha256').update(v).digest('hex');
let db = { accounts: {}, properties: [], posts: [] };
try { db = { ...db, ...JSON.parse(await readFile(DB_FILE, 'utf8')) }; } catch {}
let writes = Promise.resolve();
function persist() { writes = writes.then(async () => { await mkdir(dirname(DB_FILE), { recursive: true }); await writeFile(DB_FILE, JSON.stringify(db, null, 2)); }); return writes; }
function json(res, status, body) { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type, authorization', 'access-control-allow-methods': 'GET, POST, PATCH, DELETE, OPTIONS' }); res.end(JSON.stringify(body)); }
async function body(req) { let text = ''; for await (const chunk of req) { text += chunk; if (text.length > 2_000_000) throw Object.assign(new Error('Request too large'), { status: 413 }); } return text ? JSON.parse(text) : {}; }
function signSession(phone) {
  const payload = Buffer.from(JSON.stringify({ phone, exp: Date.now() + SESSION_TTL })).toString('base64url');
  const signature = createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}
function auth(req) {
  const [payload, signature] = (req.headers.authorization?.replace(/^Bearer\s+/i, '') || '').split('.');
  if (!payload || !signature) return null;
  const expected = createHmac('sha256', SESSION_SECRET).update(payload).digest();
  let received;
  try { received = Buffer.from(signature, 'base64url'); } catch { return null; }
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) return null;
  try { const session = JSON.parse(Buffer.from(payload, 'base64url').toString()); return session.exp > Date.now() ? db.accounts[session.phone] || null : null; } catch { return null; }
}
function phoneValid(phone) { return /^\+\d{10,15}$/.test(String(phone || '')); }
function safeAccount(a) { const { phone, name, role, persona, subscriptionActive, plan } = a; return { phone, name, role, persona, subscriptionActive, plan }; }
function twilioConfig() { const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_VERIFY_SERVICE_SID } = process.env; return TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && TWILIO_VERIFY_SERVICE_SID ? { accountSid: TWILIO_ACCOUNT_SID, authToken: TWILIO_AUTH_TOKEN, serviceSid: TWILIO_VERIFY_SERVICE_SID } : null; }
async function twilioVerify(path, params) {
  const cfg = twilioConfig();
  const response = await fetch(`https://verify.twilio.com/v2/Services/${cfg.serviceSid}/${path}`, {
    method: 'POST',
    headers: { Authorization: `Basic ${Buffer.from(`${cfg.accountSid}:${cfg.authToken}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const invalidCode = path === 'VerificationCheck' && response.status === 404;
    const error = new Error(invalidCode ? 'That code is incorrect, expired, or has already been used. Request a new code if needed.' : data.message || 'Could not send or verify the code. Try again shortly.');
    error.status = invalidCode ? 400 : response.status === 429 ? 429 : 502;
    throw error;
  }
  return data;
}
const server = createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return json(res, 204, {});
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (req.method === 'GET' && url.pathname === '/api/health') return json(res, 200, { ok: true });
    if (req.method === 'POST' && url.pathname === '/api/auth/otp') {
      const { phone, mode, role, persona } = await body(req);
      if (!phoneValid(phone)) return json(res, 400, { error: 'Enter a valid phone number.' });
      if (mode === 'signup' && db.accounts[phone]) return json(res, 409, { error: 'An account with this number already exists — log in instead.' });
      if (mode === 'login' && !db.accounts[phone]) return json(res, 404, { error: 'No account found with this number — sign up instead.' });
      const lastSentAt = otpSendLimits.get(phone) || 0;
      if (Date.now() - lastSentAt < 30_000) return json(res, 429, { error: 'Please wait before requesting another code.' });
      const challenge = { mode, role: role === 'lister' ? 'lister' : 'customer', persona: persona === 'professional' ? 'professional' : 'student', expiresAt: Date.now() + OTP_TTL, attempts: 0 };
      if (OTP_DEV_MODE) {
        const code = String(randomInt(100000, 1_000_000));
        otps.set(phone, { ...challenge, digest: hash(code) });
        otpSendLimits.set(phone, Date.now());
        return json(res, 200, { expiresAt: challenge.expiresAt, demoCode: code, delivery: 'demo' });
      }
      if (!twilioConfig()) return json(res, 503, { error: 'SMS verification is not configured. Set the Twilio Verify environment variables, then try again.' });
      const sent = await twilioVerify('Verifications', { To: phone, Channel: 'sms' });
      otps.set(phone, { ...challenge, provider: 'twilio' });
      otpSendLimits.set(phone, Date.now());
      return json(res, 200, { expiresAt: challenge.expiresAt, delivery: sent.channel || 'sms' });
    }
    if (req.method === 'POST' && url.pathname === '/api/auth/verify') {
      const { phone, code, mode, name, role, persona } = await body(req);
      const otp = otps.get(phone);
      if (!otp || otp.expiresAt < Date.now()) return json(res, 400, { error: 'This code has expired. Request a new one.' });
      if (otp.mode !== mode || otp.role !== (role === 'lister' ? 'lister' : 'customer') || otp.persona !== (persona === 'professional' ? 'professional' : 'student')) return json(res, 400, { error: 'Your sign-in selection changed. Request a new code.' });
      if (++otp.attempts > 5) { otps.delete(phone); return json(res, 429, { error: 'Too many incorrect attempts. Request a new code.' }); }
      if (otp.provider === 'twilio') {
        const checked = await twilioVerify('VerificationCheck', { To: phone, Code: String(code || '') });
        if (checked.status !== 'approved') return json(res, 400, { error: 'Incorrect code. Please try again.' });
      } else {
        const given = Buffer.from(hash(String(code || ''))); const expected = Buffer.from(otp.digest);
        if (given.length !== expected.length || !timingSafeEqual(given, expected)) return json(res, 400, { error: 'Incorrect code. Please try again.' });
      }
      otps.delete(phone);
      if (mode === 'signup') {
        if (!String(name || '').trim()) return json(res, 400, { error: 'Enter your name.' });
        if (db.accounts[phone]) return json(res, 409, { error: 'An account with this number already exists — log in instead.' });
        db.accounts[phone] = { phone, name: String(name).trim(), role: role === 'lister' ? 'lister' : 'customer', persona: persona === 'professional' ? 'professional' : 'student', subscriptionActive: false, plan: null, createdAt: new Date().toISOString() };
        await persist();
      }
      const account = db.accounts[phone];
      if (!account) return json(res, 404, { error: 'No account found with this number — sign up instead.' });
      if (account.role !== (role === 'lister' ? 'lister' : 'customer') || account.persona !== (persona === 'professional' ? 'professional' : 'student')) return json(res, 403, { error: `This number is registered as ${account.role === 'lister' ? 'Owner' : 'Tenant'} · ${account.persona === 'professional' ? 'Professional' : 'Student'}. Choose that option above to log in.` });
      const token = signSession(phone);
      return json(res, 200, { token, account: safeAccount(account) });
    }
    if (req.method === 'GET' && url.pathname === '/api/me') { const account = auth(req); return account ? json(res, 200, { account: safeAccount(account) }) : json(res, 401, { error: 'Sign in required.' }); }
    const account = auth(req);
    if (url.pathname.startsWith('/api/') && url.pathname !== '/api/auth/logout' && !account) return json(res, 401, { error: 'Sign in required.' });
    if (req.method === 'POST' && url.pathname === '/api/auth/logout') return json(res, 200, { ok: true });
    if (req.method === 'GET' && url.pathname === '/api/properties') return json(res, 200, { properties: db.properties });
    if (req.method === 'POST' && url.pathname === '/api/properties') {
      if (account.role !== 'lister' || !account.subscriptionActive) return json(res, 403, { error: 'An active owner subscription is required to publish listings.' });
      const p = await body(req);
      const requestedAudiences = Array.isArray(p.tenantFor) ? p.tenantFor : p.tenantFor === 'any' || !p.tenantFor ? ['students', 'professionals'] : [p.tenantFor];
      const tenantFor = [...new Set(requestedAudiences.filter((audience) => audience === 'students' || audience === 'professionals'))];
      if (!tenantFor.length) return json(res, 400, { error: 'Choose at least one renter category for this listing.' });
      const listing = { ...p, tenantFor, id: randomUUID(), ownerPhone: account.phone, ownerName: account.name, status: 'pending', premium: false, reviews: [] };
      db.properties.unshift(listing); await persist(); return json(res, 201, { listing });
    }
    const propertyMatch = url.pathname.match(/^\/api\/properties\/([^/]+)(?:\/(review|verify|boost))?$/);
    if (propertyMatch && req.method === 'PATCH') {
      const listing = db.properties.find((p) => String(p.id) === propertyMatch[1]); if (!listing) return json(res, 404, { error: 'Listing not found.' });
      const action = propertyMatch[2];
      if (action === 'review') { if (account.role !== 'customer') return json(res, 403, { error: 'Only tenants can review listings.' }); const r = await body(req); if (!(r.rating >= 1 && r.rating <= 5) || !String(r.text || '').trim()) return json(res, 400, { error: 'A rating and review are required.' }); listing.reviews.unshift({ id: randomUUID(), author: account.name, rating: r.rating, text: String(r.text).slice(0, 1500), date: new Date().toLocaleDateString('en-IN', { month: 'short', year: 'numeric' }) }); }
      else { if (account.role !== 'lister' || listing.ownerPhone !== account.phone) return json(res, 403, { error: 'Only the listing owner can update it.' }); if (action === 'verify') listing.status = 'verified'; if (action === 'boost') listing.premium = true; }
      await persist(); return json(res, 200, { listing });
    }
    if (req.method === 'POST' && url.pathname === '/api/subscription') { const { plan, price } = await body(req); if (!plan) return json(res, 400, { error: 'Select a plan.' }); account.subscriptionActive = true; account.plan = String(plan); account.planPrice = Number(price) || 0; await persist(); return json(res, 200, { account: safeAccount(account) }); }
    if (req.method === 'GET' && url.pathname === '/api/posts') return json(res, 200, { posts: db.posts });
    if (req.method === 'POST' && url.pathname === '/api/posts') { const p = await body(req); if (!String(p.text || '').trim()) return json(res, 400, { error: 'Post text is required.' }); const post = { id: randomUUID(), author: account.name, tag: String(p.tag || 'General'), text: String(p.text).slice(0, 1500), date: 'Just now', likes: 0 }; db.posts.unshift(post); await persist(); return json(res, 201, { post }); }
    const like = url.pathname.match(/^\/api\/posts\/([^/]+)\/like$/);
    if (req.method === 'POST' && like) { const post = db.posts.find((p) => String(p.id) === like[1]); if (!post) return json(res, 404, { error: 'Post not found.' }); post.likes++; await persist(); return json(res, 200, { post }); }
    return json(res, 404, { error: 'Not found.' });
  } catch (error) { return json(res, error.status || 500, { error: error.status ? error.message : 'Internal server error.' }); }
});
server.listen(PORT, () => console.log(`Basera API listening on http://localhost:${PORT}`));
