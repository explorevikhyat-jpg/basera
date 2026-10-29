import { createServer } from 'node:http';
import { randomInt, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const PORT = Number(process.env.PORT || 3001);
const DB_FILE = resolve(process.env.BASERA_DB_FILE || './backend/data.json');
const OTP_DEV_MODE = process.env.OTP_DEV_MODE === 'true' || process.argv.includes('--demo');
const OTP_TTL = 5 * 60_000;
const sessions = new Map();
const otps = new Map();
const hash = (v) => createHash('sha256').update(v).digest('hex');
let db = { accounts: {}, properties: [], posts: [] };
try { db = { ...db, ...JSON.parse(await readFile(DB_FILE, 'utf8')) }; } catch {}
let writes = Promise.resolve();
function persist() { writes = writes.then(async () => { await mkdir(dirname(DB_FILE), { recursive: true }); await writeFile(DB_FILE, JSON.stringify(db, null, 2)); }); return writes; }
function json(res, status, body) { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type, authorization', 'access-control-allow-methods': 'GET, POST, PATCH, DELETE, OPTIONS' }); res.end(JSON.stringify(body)); }
async function body(req) { let text = ''; for await (const chunk of req) { text += chunk; if (text.length > 2_000_000) throw Object.assign(new Error('Request too large'), { status: 413 }); } return text ? JSON.parse(text) : {}; }
function auth(req) { const token = req.headers.authorization?.replace(/^Bearer\s+/i, ''); const phone = sessions.get(token); return phone ? db.accounts[phone] : null; }
function phoneValid(phone) { return /^\+\d{10,15}$/.test(String(phone || '')); }
function safeAccount(a) { const { phone, name, role, persona, subscriptionActive, plan } = a; return { phone, name, role, persona, subscriptionActive, plan }; }
const server = createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return json(res, 204, {});
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (req.method === 'GET' && url.pathname === '/api/health') return json(res, 200, { ok: true });
    if (req.method === 'POST' && url.pathname === '/api/auth/otp') {
      const { phone, mode } = await body(req);
      if (!phoneValid(phone)) return json(res, 400, { error: 'Enter a valid phone number.' });
      if (mode === 'signup' && db.accounts[phone]) return json(res, 409, { error: 'An account with this number already exists — log in instead.' });
      if (mode === 'login' && !db.accounts[phone]) return json(res, 404, { error: 'No account found with this number — sign up instead.' });
      const code = String(randomInt(100000, 1_000_000));
      otps.set(phone, { digest: hash(code), expiresAt: Date.now() + OTP_TTL, attempts: 0 });
      return json(res, 200, { expiresAt: Date.now() + OTP_TTL, ...(OTP_DEV_MODE ? { demoCode: code } : {}) });
    }
    if (req.method === 'POST' && url.pathname === '/api/auth/verify') {
      const { phone, code, mode, name, role, persona } = await body(req);
      const otp = otps.get(phone);
      if (!otp || otp.expiresAt < Date.now()) return json(res, 400, { error: 'This code has expired. Request a new one.' });
      if (++otp.attempts > 5) { otps.delete(phone); return json(res, 429, { error: 'Too many incorrect attempts. Request a new code.' }); }
      const given = Buffer.from(hash(String(code || ''))); const expected = Buffer.from(otp.digest);
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) return json(res, 400, { error: 'Incorrect code. Please try again.' });
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
      const token = randomUUID(); sessions.set(token, phone);
      return json(res, 200, { token, account: safeAccount(account) });
    }
    if (req.method === 'GET' && url.pathname === '/api/me') { const account = auth(req); return account ? json(res, 200, { account: safeAccount(account) }) : json(res, 401, { error: 'Sign in required.' }); }
    if (req.method === 'POST' && url.pathname === '/api/auth/account') { const { phone } = await body(req); const found = db.accounts[phone]; return found ? json(res, 200, { account: safeAccount(found) }) : json(res, 404, { account: null }); }
    const account = auth(req);
    if (url.pathname.startsWith('/api/') && url.pathname !== '/api/auth/logout' && !account) return json(res, 401, { error: 'Sign in required.' });
    if (req.method === 'POST' && url.pathname === '/api/auth/logout') { const token = req.headers.authorization?.replace(/^Bearer\s+/i, ''); sessions.delete(token); return json(res, 200, { ok: true }); }
    if (req.method === 'GET' && url.pathname === '/api/properties') return json(res, 200, { properties: db.properties });
    if (req.method === 'POST' && url.pathname === '/api/properties') {
      if (account.role !== 'lister' || !account.subscriptionActive) return json(res, 403, { error: 'An active owner subscription is required to publish listings.' });
      const p = await body(req); const listing = { ...p, id: randomUUID(), ownerPhone: account.phone, ownerName: account.name, status: 'pending', premium: false, reviews: [] };
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
