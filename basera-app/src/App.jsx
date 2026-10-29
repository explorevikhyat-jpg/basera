import { useState, useMemo, useEffect } from "react";
import {
  Search, MapPin, Wifi, UtensilsCrossed, ShieldCheck, ShieldQuestion, Clock, Star,
  Users, Home, SlidersHorizontal, X, ArrowRight, Sparkles, Cigarette, BookOpen,
  Sunrise, Moon, ChevronLeft, Plus, CheckCircle2, CreditCard, Award, MessageSquare,
  Building2, Wand2, Loader2, FileText, Download, Wrench, Truck, Armchair, Umbrella,
  Heart, Send, Minus, Globe, Briefcase, Laptop, LogIn, LogOut, Sun, Navigation,
} from "lucide-react";

import { AC_VALUES, AC_FILTER_OPTIONS, normalizeAc, matchesAcFilter } from "./filters.mjs";
import { ROLES, CATEGORIES, normalizeRole, normalizePersona, roleLabel, personaLabel, describeAccount, audienceForPersona, checkLoginMatch, navIdsForRole } from "./accounts.mjs";

const sessionCache = { phone: null };
const API_BASE = (typeof import.meta !== "undefined" && import.meta.env?.VITE_API_URL) || "http://localhost:3001/api";
const api = async (path, options = {}) => {
  const token = (() => { try { return localStorage.getItem("basera:token"); } catch { return null; } })();
  const response = await fetch(`${API_BASE}${path}`, { ...options, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...options.headers } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Backend request failed.");
  return data;
};

/** Normalizes phone input so formatting differences never create duplicate accounts. */
function normalizePhone(raw) {
  const digits = String(raw || "").replace(/[^\d+]/g, "");
  const stripped = digits.replace(/^0+/, "");
  if (stripped.startsWith("+")) return stripped;
  if (stripped.length === 10) return "+91" + stripped; // default to India country code
  if (stripped.length > 10) return "+" + stripped;
  return stripped;
}
function isValidPhone(raw) {
  const n = normalizePhone(raw);
  return /^\+\d{10,15}$/.test(n);
}
function maskPhone(phone) {
  if (!phone) return "";
  return phone.slice(0, -4).replace(/\d/g, "•") + phone.slice(-4);
}

/**
 * OTP delivery/verification is abstracted behind these two functions so a real
 * SMS provider (Twilio, MSG91, Firebase, etc.) can be wired in without touching
 * any UI code — just replace the bodies below with real API calls.
 * No production OTP is hardcoded: the code is generated fresh per request,
 * lives only in memory (never persisted to localStorage), and expires.
 */
const OTP_TTL_MS = 5 * 60 * 1000;
const OTP_RESEND_COOLDOWN_S = 30;
const OTP_MAX_ATTEMPTS = 5;
async function sendOtpToPhone(phone) {
  const data = await api("/auth/otp", { method: "POST", body: JSON.stringify({ phone, mode: window.__baseraAuthMode }) });
  return { code: data.demoCode || null, expiresAt: data.expiresAt };
}
async function verifyOtpWithBackend(session, enteredCode) {
  if (!session) return { ok: false, reason: "No OTP was requested for this number." };
  try {
    const data = await api("/auth/verify", { method: "POST", body: JSON.stringify({ phone: session.phone, code: enteredCode, mode: window.__baseraAuthMode, name: window.__baseraSignupName, role: window.__baseraRole, persona: window.__baseraPersona }) });
    try { localStorage.setItem("basera:token", data.token); } catch {}
    return { ok: true, account: data.account };
  } catch (error) { return { ok: false, reason: error.message }; }
}

/** Self-hosted persistence — survives refresh; no external artifact storage required. */
const BASERA_DB_VERSION = 1;
const BASERA_DB_PREFIX = `basera:v${BASERA_DB_VERSION}:`;

const baseraDb = {
  _key(k) { return BASERA_DB_PREFIX + k; },
  get(k) {
    try { return localStorage.getItem(this._key(k)); } catch (e) { return null; }
  },
  set(k, v) {
    try { localStorage.setItem(this._key(k), v); } catch (e) { /* quota / private mode */ }
  },
  remove(k) {
    try { localStorage.removeItem(this._key(k)); } catch (e) {}
  },
  loadJson(k, fallback) {
    const raw = this.get(k);
    if (raw == null) return fallback;
    try { return JSON.parse(raw); } catch (e) { return fallback; }
  },
  saveJson(k, v) {
    this.set(k, JSON.stringify(v));
  },
  getSessionPhone() {
    if (sessionCache.phone) return sessionCache.phone;
    return this.loadJson("session:phone", null);
  },
  setSessionPhone(phone) {
    sessionCache.phone = phone || null;
    if (phone) this.saveJson("session:phone", phone);
    else this.remove("session:phone");
  },
  loadProperties(seed) {
    return this.loadJson("data:properties", null) ?? seed;
  },
  saveProperties(list) {
    this.saveJson("data:properties", list);
  },
  loadPosts(seed) {
    return this.loadJson("data:posts", null) ?? seed;
  },
  savePosts(list) {
    this.saveJson("data:posts", list);
  },
  resetDemoData() {
    const keys = [];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const full = localStorage.key(i);
        if (full?.startsWith(BASERA_DB_PREFIX)) keys.push(full);
      }
      keys.forEach((full) => localStorage.removeItem(full));
    } catch (e) {}
    sessionCache.phone = null;
  },
};

if (typeof window !== "undefined") {
  window.baseraDb = baseraDb;
  window.storage = {
    get: async (k) => {
      const v = baseraDb.get(k);
      return v != null ? { value: v } : null;
    },
    set: async (k, v) => { baseraDb.set(k, v); },
  };
}

function getAnthropicApiKey() {
  try {
    if (typeof import.meta !== "undefined" && import.meta.env?.VITE_ANTHROPIC_API_KEY) {
      return import.meta.env.VITE_ANTHROPIC_API_KEY;
    }
  } catch (e) { /* not bundled with Vite */ }
  try {
    return localStorage.getItem(BASERA_DB_PREFIX + "config:anthropic-key") || "";
  } catch (e) {
    return "";
  }
}

function localAiFallback(prompt) {
  const lower = prompt.toLowerCase();
  if (lower.includes("roommate") || lower.includes("person b")) {
    return "Your schedules and food prefs line up well — agree on guests and quiet hours before you commit to sharing.";
  }
  if (lower.includes("listings") || lower.includes("recommend")) {
    const m = prompt.match(/₹(\d+)/);
    const budget = m ? +m[1] : 10000;
    return budget >= 15000
      ? "Look at verified singles or co-living with wifi first — they fit a professional budget and WFH needs."
      : "Prioritize verified PGs in your preferred area under budget; check food and wifi before reserving.";
  }
  return "Basera tip: match on sleep schedule and tidiness first — rent differences matter less than daily habits.";
}

async function askClaude(prompt) {
  const apiKey = getAnthropicApiKey();
  if (!apiKey) return localAiFallback(prompt);
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 400,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!response.ok) return localAiFallback(prompt);
  const data = await response.json();
  const text = (data.content || []).map((b) => (b.type === "text" ? b.text : "")).join("\n").trim();
  return text || localAiFallback(prompt);
}

const SUBSCRIPTION_PLANS = {
  customer: [
    { id: "tenant-monthly", name: "Tenant Access", price: 299, recurring: true, blurb: "Unlock the property map and contact owners directly — no broker." },
    { id: "tenant-annual", name: "Tenant Annual", price: 2499, recurring: false, blurb: "Same map + direct-contact access — save ~30% vs monthly." },
  ],
  lister: [
    { id: "owner-monthly", name: "Owner Lister", price: 499, recurring: true, blurb: "Publish listings, verification queue, and featured boost eligibility." },
    { id: "owner-annual", name: "Owner Annual", price: 4499, recurring: false, blurb: "List unlimited properties for a year." },
  ],
};

const PARTNER_COMPANIES = [
  { name: "Infosys", domain: "infosys.com", perk: "Reservation token waived for verified employees" },
  { name: "TCS", domain: "tcs.com", perk: "Priority listing verification for relocating staff" },
  { name: "Wipro", domain: "wipro.com", perk: "Dedicated relocation housing helpline" },
  { name: "Flipkart", domain: "flipkart.com", perk: "Reservation token waived for verified employees" },
  { name: "Swiggy", domain: "swiggy.in", perk: "Priority move-in support" },
];

const CITY_CENTER = {
  "Delhi NCR": { lat: 28.6139, lng: 77.209 },
  Bengaluru: { lat: 12.9716, lng: 77.5946 },
  Pune: { lat: 18.5204, lng: 73.8567 },
};

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

const BHK_TYPES = ["Not specified", "1 RK", "1 BHK", "2 BHK", "3 BHK", "4 BHK", "Flat", "Apartment"];
const DIMENSION_TYPES = ["Carpet Area", "Built-up Area", "Super Built-up Area"];
function formatAreaSqft(value) {
  const n = Number(value);
  if (!value || Number.isNaN(n) || n <= 0) return null;
  return `${n.toLocaleString("en-IN")} sq ft`;
}

function parseGoogleMapsInput(raw) {
  const text = raw.trim();
  if (!text) return null;
  const atMatch = text.match(/@(-?\d+\.?\d*),(-?\d+\.?\d*)/);
  if (atMatch) return { lat: +atMatch[1], lng: +atMatch[2], label: text };
  const qMatch = text.match(/[?&]q=(-?\d+\.?\d*),(-?\d+\.?\d*)/);
  if (qMatch) return { lat: +qMatch[1], lng: +qMatch[2], label: text };
  return { lat: null, lng: null, label: text, query: text };
}

function mapsEmbedSrc(loc) {
  if (loc?.lat != null && loc?.lng != null) return `https://maps.google.com/maps?q=${loc.lat},${loc.lng}&z=16&output=embed`;
  if (loc?.query) return `https://maps.google.com/maps?q=${encodeURIComponent(loc.query)}&z=15&output=embed`;
  return null;
}

// ---------- Cities ----------

const CITIES = {
  "Delhi NCR": { areas: ["Kamla Nagar", "Hudson Lane", "GTB Nagar", "Vijay Nagar", "Mukherjee Nagar"], live: true },
  "Bengaluru": { areas: ["Koramangala", "HSR Layout", "Whitefield"], live: true },
  "Pune": { areas: ["Kothrud", "Viman Nagar", "Hinjewadi"], live: true },
  "Hyderabad": { areas: [], live: false },
  "Mumbai": { areas: [], live: false },
  "Chennai": { areas: [], live: false },
  "Jaipur": { areas: [], live: false },
  "Ahmedabad": { areas: [], live: false },
};

const SEED_PROPERTIES = [
  { id: 1, ac: "AC", city: "Delhi NCR", title: "Sunrise PG for Girls", area: "Kamla Nagar", rent: 9500, type: "2-sharing", gender: "Female", food: true, wifi: true, dist: 0.4, tenantFor: "students", lat: 28.682, lng: 77.207, notes: "Warm hostel-mother, curfew 10pm, hot water 24x7.", status: "verified", premium: false,
    reviews: [ { id: 1, author: "Neha S.", rating: 5, text: "Felt safe from day one, warden checks in without being annoying.", date: "Mar 2026" }, { id: 2, author: "Ritika D.", rating: 4, text: "Food is decent, wifi drops during exam season when everyone's online.", date: "Jan 2026" } ] },
  { id: 2, ac: "AC", city: "Delhi NCR", title: "Hudson Lane Studio", area: "Hudson Lane", rent: 14000, type: "Single", gender: "Any", food: false, wifi: true, dist: 0.8, notes: "Independent studio above a cafe, own kitchenette.", status: "verified", premium: false,
    reviews: [ { id: 1, author: "Farhan K.", rating: 4, text: "Loud on weekends because of the cafe downstairs, otherwise great.", date: "Feb 2026" } ] },
  { id: 3, ac: "Non-AC", city: "Delhi NCR", title: "Blue Nest Boys Hostel", area: "GTB Nagar", rent: 7800, type: "3-sharing", gender: "Male", food: true, wifi: true, dist: 0.6, notes: "Budget-friendly, mess food twice daily, no lift.", status: "unverified", premium: false, reviews: [] },
  { id: 4, ac: "AC", city: "Delhi NCR", title: "Campus View 2BHK", area: "Vijay Nagar", rent: 18000, type: "2BHK flat", gender: "Any", food: false, wifi: true, dist: 1.2, notes: "Full flat, split between 2 flatmates, balcony, washing machine.", status: "verified", premium: true,
    reviews: [ { id: 1, author: "Ishaan M.", rating: 5, text: "Owner responds within the hour, deposit was refunded fully on move-out.", date: "Apr 2026" }, { id: 2, author: "Divya R.", rating: 5, text: "Best kept flat on this list, washing machine alone is worth the rent.", date: "Mar 2026" } ] },
  { id: 5, ac: "Non-AC", city: "Delhi NCR", title: "Mukherjee Nagar Girls PG", area: "Mukherjee Nagar", rent: 10200, type: "3-sharing", gender: "Female", food: true, wifi: false, dist: 2.1, notes: "Near coaching hub, strict security, biometric entry.", status: "verified", premium: false,
    reviews: [ { id: 1, author: "Pooja T.", rating: 4, text: "Great for focused prep, but no wifi means you need your own data plan.", date: "Dec 2025" } ] },
  { id: 6, ac: "Non-AC", city: "Delhi NCR", title: "Budget Boys Room", area: "Kamla Nagar", rent: 6500, type: "4-sharing", gender: "Male", food: false, wifi: false, dist: 0.5, notes: "No-frills, cheapest option on the belt, cot + almirah only.", status: "unverified", premium: false, reviews: [] },
  { id: 7, ac: "AC", city: "Delhi NCR", title: "Green Terrace Co-living", area: "Hudson Lane", rent: 16500, type: "Single (co-living)", gender: "Any", food: true, wifi: true, dist: 0.9, notes: "Community events, rooftop terrace, weekly housekeeping.", status: "verified", premium: true,
    reviews: [ { id: 1, author: "Aman V.", rating: 5, text: "Paid a bit more but made friends here in week one, worth it.", date: "Feb 2026" } ] },
  { id: 8, ac: "Non-AC", city: "Delhi NCR", title: "Riverside Girls Hostel", area: "GTB Nagar", rent: 8900, type: "2-sharing", gender: "Female", food: true, wifi: true, dist: 0.7, notes: "Metro-adjacent, warden on-site, laundry service included.", status: "verified", premium: false,
    reviews: [ { id: 1, author: "Sneha B.", rating: 4, text: "Laundry service is a lifesaver during placement season.", date: "Jan 2026" } ] },
  { id: 9, ac: "AC", city: "Bengaluru", title: "Cauvery PG for Women", area: "Koramangala", rent: 13000, type: "2-sharing", gender: "Female", food: true, wifi: true, dist: 0.6, notes: "Close to tech-park shuttle stop, biometric entry.", status: "verified", premium: false,
    reviews: [ { id: 1, author: "Meera V.", rating: 4, text: "Great location, food could use more variety.", date: "May 2026" } ] },
  { id: 10, ac: "AC", city: "Bengaluru", title: "Whitefield Tech Studio", area: "Whitefield", rent: 19000, type: "Single", gender: "Any", food: false, wifi: true, dist: 1.5, tenantFor: "professionals", lat: 12.969, lng: 77.749, notes: "Fully furnished studio, 10 min from major tech parks.", status: "verified", premium: true, reviews: [] },
  { id: 11, ac: "AC", city: "Bengaluru", title: "HSR Coliving Loft", area: "HSR Layout", rent: 21000, type: "Single (co-living)", gender: "Any", food: true, wifi: true, dist: 0.9, notes: "Community workspace on-site, weekend meetups.", status: "unverified", premium: false, reviews: [] },
  { id: 12, ac: "Non-AC", city: "Pune", title: "Kothrud Girls Hostel", area: "Kothrud", rent: 8500, type: "3-sharing", gender: "Female", food: true, wifi: true, dist: 0.5, notes: "Quiet residential lane, warden on-site.", status: "verified", premium: false, reviews: [] },
  { id: 13, ac: "AC", city: "Pune", title: "Hinjewadi IT Park Flat", area: "Hinjewadi", rent: 16000, type: "2BHK flat", gender: "Any", food: false, wifi: true, dist: 2.0, notes: "Split flat near IT park, shuttle access nearby.", status: "verified", premium: false, reviews: [] },
  { id: 14, city: "Pune", title: "Viman Nagar Studio", area: "Viman Nagar", rent: 12500, type: "Single", gender: "Any", food: false, wifi: true, dist: 1.1, notes: "Compact studio, close to cafes and a co-working space.", status: "unverified", premium: false, reviews: [] },
];

const CANDIDATES = [
  { id: "a", city: "Delhi NCR", name: "Ananya", area: "Kamla Nagar", budget: 9000, gender: "Female", food: "Veg", sleep: "Early bird", clean: "Very tidy", smoking: "No", study: "Quiet focus", personaType: "student", bio: "3rd-year eco-hons, plant mom, sleeps by 11." },
  { id: "b", city: "Delhi NCR", name: "Priya", area: "Hudson Lane", budget: 12000, gender: "Female", food: "Either", sleep: "Early bird", clean: "Very tidy", smoking: "No", study: "Quiet focus", personaType: "student", bio: "Design student, keeps a strict desk-only rule." },
  { id: "c", city: "Delhi NCR", name: "Simran", area: "Mukherjee Nagar", budget: 8500, gender: "Female", food: "Veg", sleep: "Flexible", clean: "Moderately tidy", smoking: "No", study: "Quiet focus", personaType: "student", bio: "Prepping for a competitive exam, mostly at the library." },
  { id: "d", city: "Delhi NCR", name: "Rohan", area: "GTB Nagar", budget: 7500, gender: "Male", food: "Non-veg", sleep: "Night owl", clean: "Relaxed", smoking: "Occasional", study: "Social study", personaType: "student", bio: "Plays guitar, works better with music on." },
  { id: "e", city: "Delhi NCR", name: "Karan", area: "Vijay Nagar", budget: 15000, gender: "Male", food: "Non-veg", sleep: "Night owl", clean: "Relaxed", smoking: "No", study: "Social study", personaType: "student", bio: "Football on weekends, cooks a mean maggi at 2am." },
  { id: "f", city: "Delhi NCR", name: "Aditya", area: "Kamla Nagar", budget: 7000, gender: "Male", food: "Either", sleep: "Early bird", clean: "Moderately tidy", smoking: "No", study: "Social study", personaType: "student", bio: "Cricket fan, first year, looking to make friends." },
  { id: "g", city: "Delhi NCR", name: "Arjun", area: "Hudson Lane", budget: 18000, gender: "Male", food: "Non-veg", sleep: "Night owl", clean: "Moderately tidy", smoking: "No", study: "WFH quiet", personaType: "professional", bio: "Product manager, hybrid 3 days office, needs quiet WFH mornings." },
  { id: "h", city: "Bengaluru", name: "Nisha", area: "Koramangala", budget: 16000, gender: "Female", food: "Either", sleep: "Flexible", clean: "Very tidy", smoking: "No", study: "Office regular", personaType: "professional", bio: "Consultant at a tech park, early gym, no loud parties on weekdays." },
  { id: "i", city: "Bengaluru", name: "Vikram", area: "Whitefield", budget: 20000, gender: "Male", food: "Either", sleep: "Early bird", clean: "Very tidy", smoking: "No", study: "Hybrid/social", personaType: "professional", bio: "Relocated from Pune, looking for a flatmate who respects shared spaces." },
];

const PARTNER_COLLEGES = [
  { name: "Delhi University (DU)", domain: "du.ac.in", perk: "Reservation token waived for enrolled students" },
  { name: "Indraprastha University (IPU)", domain: "ipu.ac.in", perk: "Priority listing verification" },
  { name: "Jamia Millia Islamia", domain: "jmi.ac.in", perk: "Dedicated housing helpline" },
  { name: "Delhi Technological University (DTU)", domain: "dtu.ac.in", perk: "Reservation token waived for enrolled students" },
  { name: "Amity University", domain: "amity.edu", perk: "Priority listing verification" },
];
const PREMIUM_FEE = 999;
const TOKEN_AMOUNT = 500;
const MOVERS = [
  { id: "m1", name: "QuickShift Movers", tagline: "Two-wheeler + hand-cart for hostel loads", rating: 4.6, local: 1500, intercity: 6500 },
  { id: "m2", name: "CampusVan", tagline: "Mini-van, good for 2BHK/full-flat moves", rating: 4.4, local: 2200, intercity: 8500 },
  { id: "m3", name: "PackNGo Express", tagline: "Packing included, insured handling", rating: 4.8, local: 3000, intercity: 12000 },
];
const FURNITURE = [
  { id: "f1", name: "Single bed + mattress", price: 799 }, { id: "f2", name: "Study table + chair", price: 499 },
  { id: "f3", name: "2-door wardrobe", price: 599 }, { id: "f4", name: "Mini fridge (small)", price: 649 },
  { id: "f5", name: "Study lamp", price: 99 }, { id: "f6", name: "Bookshelf", price: 349 },
];
const INSURANCE_PLANS = [
  { id: "basic", name: "Basic", price: 99, cover: "₹20,000", points: ["Laptop & electronics cover", "Basic accidental damage"] },
  { id: "standard", name: "Standard", price: 199, cover: "₹50,000", points: ["Everything in Basic", "Theft cover", "Room-fire cover"] },
  { id: "premium", name: "Premium", price: 349, cover: "₹1,00,000", points: ["Everything in Standard", "Natural calamity cover", "Priority claim processing"] },
];
const SEED_POSTS = [
  { id: 1, author: "Ritika D.", tag: "Marketplace", text: "Selling a barely-used study lamp + bookshelf, moving out end of month. DM if interested.", date: "2h ago", likes: 4 },
  { id: 2, author: "Aman V.", tag: "Event", text: "Rooftop movie night at Green Terrace this Saturday, 8pm. Anyone on the belt is welcome!", date: "5h ago", likes: 11 },
  { id: 3, author: "Farhan K.", tag: "Help", text: "Wifi's been flaky near Hudson Lane main road since Monday — anyone else facing this or is it just my building?", date: "1d ago", likes: 6 },
];

// ---------- helpers ----------

function avgRating(reviews) { if (!reviews.length) return null; return (reviews.reduce((s, r) => s + r.rating, 0) / reviews.length).toFixed(1); }

function matchScore(p, c) {
  let s = 0;
  const bd = Math.abs(p.budget - c.budget);
  s += bd <= 1000 ? 20 : bd <= 3000 ? 10 : 2;
  s += p.area === c.area ? 15 : 5;
  s += p.food === c.food ? 15 : p.food === "Either" || c.food === "Either" ? 10 : 0;
  s += p.sleep === c.sleep ? 15 : p.sleep === "Flexible" || c.sleep === "Flexible" ? 8 : 0;
  s += p.clean === c.clean ? 15 : 5;
  s += p.smoking === c.smoking ? 10 : 0;
  s += p.study === c.study ? 10 : 4;
  return Math.round(s);
}

// Cover photos for the sample listings (owner-uploaded photos always take priority).
const COVER_IMAGES = [
  "https://images.unsplash.com/photo-1522708323590-d24dbb6b0267?auto=format&fit=crop&w=700&q=80",
  "https://images.unsplash.com/photo-1502672260266-1c1ef2d93688?auto=format&fit=crop&w=700&q=80",
  "https://images.unsplash.com/photo-1560448204-e02f11c3d0e2?auto=format&fit=crop&w=700&q=80",
  "https://images.unsplash.com/photo-1502005229762-ae1b460020e2?auto=format&fit=crop&w=700&q=80",
  "https://images.unsplash.com/photo-1493809842364-78817add7ffb?auto=format&fit=crop&w=700&q=80",
  "https://images.unsplash.com/photo-1536376072261-38c75010e6c9?auto=format&fit=crop&w=700&q=80",
];
function coverFor(p) {
  if (p.photos?.[0]?.dataUrl) return p.photos[0].dataUrl;
  if (p.img) return p.img;
  if (SEED_PROPERTIES.some((sp) => sp.id === p.id)) return COVER_IMAGES[(p.id - 1) % COVER_IMAGES.length];
  return null;
}
/** Image with a graceful icon fallback if the URL fails to load (offline, blocked, etc.). */
function CardImage({ src, alt, className = "", iconSize = 22 }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); }, [src]);
  if (!src || failed) return <Home size={iconSize} style={{ color: "var(--marigold)" }} />;
  return <img src={src} alt={alt} className={`w-full h-full object-cover ${className}`} loading="lazy" onError={() => setFailed(true)} />;
}

// tilt sequence for the pinned-notice motif — deliberately irregular, not a repeating pattern
const TILTS = [-1.4, 0.9, -0.6, 1.6, -1.1, 0.5];
const tilt = (i) => `${TILTS[i % TILTS.length]}deg`;

function PinDot({ color = "var(--stamp)" }) {
  return (
    <span aria-hidden="true" style={{
      position: "absolute", top: -7, left: "50%", transform: "translateX(-50%)",
      width: 13, height: 13, borderRadius: "50%",
      background: `radial-gradient(circle at 35% 30%, #fff8, ${color} 55%, rgba(0,0,0,0.35))`,
      boxShadow: "0 3px 4px rgba(20,15,5,0.35)", zIndex: 2,
    }} />
  );
}

function Stamp({ children, color = "var(--stamp)", rotate = -7, style }) {
  return (
    <span className="font-mono stamp-surface" style={{
      display: "inline-flex", alignItems: "center", gap: 4, fontSize: 10, fontWeight: 700,
      letterSpacing: "0.08em", textTransform: "uppercase", color, border: `1.5px dashed ${color}`,
      borderRadius: 5, padding: "2px 7px", transform: `rotate(${rotate}deg)`, background: "rgba(255,255,255,0.5)",
      ...style,
    }}>{children}</span>
  );
}

function Notice({ i = 0, pinColor, className = "", style, children, as: _as, onClick, ...rest }) {
  // Tilt lives in a CSS variable so hover can straighten the card (inline transforms would block that).
  const { transform: userTransform, ...restStyle } = style || {};
  const tiltMatch = typeof userTransform === "string" ? userTransform.match(/rotate\(([^)]+)\)/) : null;
  const clickable = typeof onClick === "function";
  return (
    <div
      className={`notice-card relative ${clickable ? "cursor-pointer" : ""} ${className}`}
      style={{ "--tilt": tiltMatch ? tiltMatch[1] : tilt(i), background: "var(--paper)", border: "1px solid color-mix(in srgb, var(--ink) 12%, transparent)", boxShadow: "0 2px 0 color-mix(in srgb, var(--ink) 6%, transparent), 0 10px 18px -12px color-mix(in srgb, var(--ink) 35%, transparent)", ...restStyle }}
      onClick={onClick}
      {...(clickable ? { role: "button", tabIndex: 0, onKeyDown: (e) => { if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); onClick(e); } } } : {})}
      {...rest}
    >
      <PinDot color={pinColor} />
      {children}
    </div>
  );
}

function Gauge({ score }) {
  const ticks = Math.round(score / 10);
  return (
    <div className="flex items-center gap-2">
      <div className="flex gap-[3px]">{Array.from({ length: 10 }).map((_, i) => <div key={i} className="w-[6px] h-4" style={{ background: i < ticks ? "var(--marigold)" : "color-mix(in srgb, var(--ink) 14%, transparent)", borderRadius: 1 }} />)}</div>
      <span className="font-mono text-sm font-bold" style={{ color: "var(--ink)" }}>{score}%</span>
    </div>
  );
}

function StatusStamp({ status }) {
  if (status === "verified") return <Stamp color="var(--sage)" rotate={-6}><ShieldCheck size={11} /> Verified</Stamp>;
  if (status === "pending") return <Stamp color="var(--marigold)" rotate={-4}><Clock size={11} /> Pending review</Stamp>;
  return <span className="flex items-center gap-1 text-[11px] font-medium" style={{ color: "color-mix(in srgb, var(--ink) 40%, transparent)" }}><ShieldQuestion size={12} /> Not verified</span>;
}

function MaintStatusBadge({ status }) {
  const map = { Submitted: "var(--marigold)", "In progress": "#3B6FA6", Resolved: "var(--sage)" };
  return <Stamp color={map[status] || "var(--marigold)"} rotate={-3}>{status}</Stamp>;
}

function StarPicker({ value, onChange }) {
  return <div className="flex gap-1">{[1, 2, 3, 4, 5].map((n) => <button key={n} type="button" onClick={() => onChange(n)}><Star size={20} fill={n <= value ? "var(--marigold)" : "none"} style={{ color: "var(--marigold)" }} /></button>)}</div>;
}

// ticket-style checkout — torn perforated edge, receipt layout
function TornEdge({ color = "var(--paper)" }) {
  return <div style={{ height: 12, background: `radial-gradient(circle at 8px 0, transparent 7px, ${color} 7.2px)`, backgroundSize: "16px 12px", backgroundPosition: "-4px -6px" }} />;
}

const UPI_APPS = ["Google Pay", "PhonePe", "Paytm"];

function PaymentModal({ info, onClose, onSuccess }) {
  const [step, setStep] = useState("form");
  const [method, setMethod] = useState("upi");
  const [app, setApp] = useState("Google Pay");
  const [upiId, setUpiId] = useState("");
  if (!info) return null;
  const canPay = info.amount === 0 || method === "card" || (method === "upi" && upiId.trim().includes("@"));
  return (
    <div className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center p-0 sm:p-6" style={{ background: "rgba(20,26,34,0.6)" }} onClick={onClose}>
      <div className="w-full sm:max-w-sm overflow-hidden" style={{ background: "var(--paper)", borderRadius: 4, transform: "rotate(-0.4deg)", boxShadow: "0 20px 40px -10px rgba(0,0,0,0.4)" }} onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-4 flex items-center justify-between" style={{ background: "var(--panel)" }}>
          <span className="flex items-center gap-2 text-xs font-mono font-bold uppercase tracking-wider" style={{ color: "var(--panel-text)" }}><CreditCard size={15} /> Basera receipt</span>
          <button onClick={onClose}><X size={18} style={{ color: "var(--panel-text)" }} /></button>
        </div>
        <TornEdge />
        <div className="px-5 pb-5">
          {step === "form" ? (
            <>
              <p className="text-sm font-medium mt-1" style={{ color: "var(--ink)" }}>{info.label}</p>
              <p className="font-mono text-3xl font-bold mt-1" style={{ color: "var(--ink)" }}>₹{info.amount.toLocaleString("en-IN")}{info.recurring && <span className="text-sm font-normal">/mo</span>}</p>
              {info.amount === 0 ? (
                <p className="text-xs mt-2 font-mono" style={{ color: "var(--sage)" }}>PARTNER DISCOUNT — NOTHING TO PAY</p>
              ) : (
                <>
                  <div className="flex gap-2 mt-4">
                    <button onClick={() => setMethod("upi")} className="flex-1 text-xs font-mono font-bold uppercase py-2" style={{ background: method === "upi" ? "var(--ink)" : "var(--kraft)", color: method === "upi" ? "var(--kraft)" : "var(--ink)" }}>UPI</button>
                    <button onClick={() => setMethod("card")} className="flex-1 text-xs font-mono font-bold uppercase py-2" style={{ background: method === "card" ? "var(--ink)" : "var(--kraft)", color: method === "card" ? "var(--kraft)" : "var(--ink)" }}>Card</button>
                  </div>
                  {method === "upi" ? (
                    <div className="mt-3 space-y-2">
                      <div className="flex gap-2">
                        {UPI_APPS.map((a) => (
                          <button key={a} onClick={() => setApp(a)} className="flex-1 text-[11px] font-mono font-bold py-1.5" style={{ border: app === a ? "1.5px solid var(--marigold)" : "1px solid color-mix(in srgb, var(--ink) 20%, transparent)", color: "var(--ink)", background: app === a ? "color-mix(in srgb, var(--marigold) 15%, transparent)" : "transparent" }}>{a}</button>
                        ))}
                      </div>
                      <input placeholder="yourname@okhdfcbank" value={upiId} onChange={(e) => setUpiId(e.target.value)} className="w-full text-sm px-3 py-2 font-mono" style={{ border: "1px dashed color-mix(in srgb, var(--ink) 30%, transparent)", background: "var(--kraft)" }} />
                      <p className="text-[11px] font-mono" style={{ color: "color-mix(in srgb, var(--ink) 45%, transparent)" }}>Enter your UPI ID, or open {app} to scan &amp; pay (demo).</p>
                    </div>
                  ) : (
                    <div className="space-y-2 mt-3">
                      <input placeholder="Card number (demo)" defaultValue="4242 4242 4242 4242" className="w-full text-sm px-3 py-2 font-mono" style={{ border: "1px dashed color-mix(in srgb, var(--ink) 30%, transparent)", background: "var(--kraft)" }} />
                      <div className="flex gap-2">
                        <input placeholder="MM/YY" defaultValue="12/28" className="w-1/2 text-sm px-3 py-2 font-mono" style={{ border: "1px dashed color-mix(in srgb, var(--ink) 30%, transparent)", background: "var(--kraft)" }} />
                        <input placeholder="CVV" defaultValue="123" className="w-1/2 text-sm px-3 py-2 font-mono" style={{ border: "1px dashed color-mix(in srgb, var(--ink) 30%, transparent)", background: "var(--kraft)" }} />
                      </div>
                    </div>
                  )}
                </>
              )}
              <button onClick={() => setStep("success")} disabled={!canPay} className="w-full mt-4 py-2.5 text-sm font-bold uppercase tracking-wide disabled:opacity-40" style={{ background: "var(--marigold)", color: "var(--ink)", borderRadius: 3 }}>{info.amount === 0 ? "Confirm — ₹0" : method === "upi" ? `Pay ₹${info.amount.toLocaleString("en-IN")} via UPI` : `Pay ₹${info.amount.toLocaleString("en-IN")}`}</button>
              <p className="text-[11px] text-center mt-3" style={{ color: "color-mix(in srgb, var(--ink) 45%, transparent)" }}>Demo checkout — no real payment is processed.</p>
            </>
          ) : (
            <div className="text-center py-3">
              <Stamp color="var(--sage)" rotate={-8} style={{ fontSize: 13, padding: "6px 14px", borderWidth: 2 }}><CheckCircle2 size={16} /> Paid</Stamp>
              <p className="mt-4" style={{ color: "var(--ink)", fontFamily: "'Big Shoulders Display', sans-serif", fontSize: 26, fontWeight: 700, textTransform: "uppercase" }}>Payment received</p>
              <p className="text-sm mt-1" style={{ color: "color-mix(in srgb, var(--ink) 65%, transparent)" }}>{info.successText}</p>
              <button onClick={() => { onSuccess(); onClose(); }} className="w-full mt-5 py-2.5 text-sm font-bold uppercase tracking-wide" style={{ background: "var(--panel)", color: "var(--panel-text)", borderRadius: 3 }}>Done</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function AgreementModal({ property, studentName, setStudentName, onClose, onSigned }) {
  const [agreed, setAgreed] = useState(false);
  if (!property) return null;
  const today = new Date().toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" });
  const text = `BASERA — DIGITAL RENTAL INTEREST AGREEMENT (DEMO, NON-BINDING)
Generated ${today}

Renter: ${studentName || "________________"}
Property: ${property.title}
Location: ${property.area}, ${property.city}
Monthly rent: ₹${property.rent.toLocaleString("en-IN")}
Room type: ${property.type}

Terms (illustrative only):
1. This document confirms intent to reserve the above room and is not a legal lease.
2. A formal rental agreement should be signed directly with the property owner before move-in.
3. The reservation token paid via Basera is refundable per the platform's cancellation policy.

Signed electronically by ${studentName || "the renter"} on ${today}.`;
  function download() {
    const blob = new Blob([text], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `${property.title.replace(/\s+/g, "-")}-agreement.txt`; a.click();
    URL.revokeObjectURL(url);
  }
  return (
    <div className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center p-0 sm:p-6" style={{ background: "rgba(20,26,34,0.6)" }} onClick={onClose}>
      <div className="w-full sm:max-w-md overflow-hidden max-h-[90vh] flex flex-col" style={{ background: "var(--paper)", borderRadius: 4, boxShadow: "0 20px 40px -10px rgba(0,0,0,0.4)" }} onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-4 flex items-center justify-between flex-shrink-0" style={{ background: "var(--panel)" }}>
          <span className="flex items-center gap-2 text-xs font-mono font-bold uppercase tracking-wider" style={{ color: "var(--panel-text)" }}><FileText size={15} /> Digital agreement</span>
          <button onClick={onClose}><X size={18} style={{ color: "var(--panel-text)" }} /></button>
        </div>
        <div className="p-5 overflow-y-auto">
          <input placeholder="Your full name" value={studentName} onChange={(e) => setStudentName(e.target.value)} className="w-full text-sm px-3 py-2 mb-3" style={{ border: "1px dashed color-mix(in srgb, var(--ink) 30%, transparent)", background: "var(--kraft)" }} />
          <pre className="text-xs whitespace-pre-wrap p-3 font-mono" style={{ background: "var(--kraft)", color: "var(--ink)", border: "1px solid color-mix(in srgb, var(--ink) 12%, transparent)" }}>{text}</pre>
          <label className="flex items-center gap-2 text-sm mt-3"><input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} /> I confirm the details above are accurate</label>
          <button disabled={!agreed || !studentName} onClick={() => { download(); onSigned(); onClose(); }} className="w-full mt-4 flex items-center justify-center gap-2 py-2.5 text-sm font-bold uppercase tracking-wide disabled:opacity-40" style={{ background: "var(--marigold)", color: "var(--ink)", borderRadius: 3 }}><Download size={15} /> Sign &amp; download</button>
        </div>
      </div>
    </div>
  );
}

const HEAD = { fontFamily: "'Big Shoulders Display', sans-serif", textTransform: "uppercase", fontWeight: 700, letterSpacing: "0.01em" };

function SectionTitle({ children, sub }) {
  return (
    <div className="mb-5">
      <h2 style={{ ...HEAD, fontSize: 30, color: "var(--ink)", lineHeight: 1 }}>{children}</h2>
      <div style={{ width: 46, height: 3, background: "var(--marigold)", marginTop: 8, marginBottom: sub ? 8 : 0 }} />
      {sub && <p className="text-sm" style={{ color: "color-mix(in srgb, var(--ink) 60%, transparent)" }}>{sub}</p>}
    </div>
  );
}

function GoogleLocationPicker({ value, onChange, label = "Pin on Google Maps" }) {
  const [draft, setDraft] = useState(value?.label || "");
  useEffect(() => { setDraft(value?.label || ""); }, [value?.label]);
  const embed = mapsEmbedSrc(value);
  return (
    <div className="space-y-2">
      <label className="text-xs font-mono uppercase tracking-wide" style={{ color: "color-mix(in srgb, var(--ink) 50%, transparent)" }}>{label}</label>
      <p className="text-[11px]" style={{ color: "color-mix(in srgb, var(--ink) 45%, transparent)" }}>Paste a Google Maps link, coordinates, or street address — we store it with your listing.</p>
      <div className="flex gap-2 flex-wrap">
        <input placeholder="https://maps.app.goo.gl/... or Kamla Nagar, Delhi" value={draft} onChange={(e) => setDraft(e.target.value)} className="flex-1 min-w-[200px] text-sm px-3 py-2 font-mono" style={{ border: "1px dashed color-mix(in srgb, var(--ink) 30%, transparent)", background: "var(--kraft)" }} />
        <button type="button" onClick={() => onChange(parseGoogleMapsInput(draft))} className="px-4 py-2 text-xs font-bold uppercase" style={{ background: "var(--marigold)", color: "var(--ink)" }}>Set location</button>
      </div>
      {embed && (
        <div className="overflow-hidden" style={{ border: "1px solid color-mix(in srgb, var(--ink) 15%, transparent)", borderRadius: 4 }}>
          <iframe title="Property location" src={embed} width="100%" height={200} style={{ border: 0 }} loading="lazy" referrerPolicy="no-referrer-when-downgrade" />
        </div>
      )}
    </div>
  );
}

function ChoiceCard({ selected, onClick, icon: Icon, title, blurb, name }) {
  return (
    <button type="button" role="radio" aria-checked={selected} name={name} onClick={onClick}
      className="text-left p-3.5 flex flex-col gap-1.5 flex-1"
      style={{ background: selected ? "color-mix(in srgb, var(--marigold) 16%, transparent)" : "var(--kraft)", border: selected ? "1.5px solid var(--marigold)" : "1px solid color-mix(in srgb, var(--ink) 18%, transparent)", borderRadius: 6, boxShadow: selected ? "0 0 14px var(--hover-glow)" : "none" }}>
      <span className="flex items-center gap-2">
        <Icon size={18} style={{ color: selected ? "var(--marigold)" : "var(--ink)" }} />
        <span style={{ ...HEAD, fontSize: 19, color: "var(--ink)" }}>{title}</span>
        {selected && <CheckCircle2 size={14} className="ml-auto" style={{ color: "var(--marigold)" }} />}
      </span>
      {blurb && <span className="text-[11px] leading-snug" style={{ color: "color-mix(in srgb, var(--ink) 62%, transparent)" }}>{blurb}</span>}
    </button>
  );
}

function AuthPortal({
  darkMode, setDarkMode, authMode, setAuthMode, authRole, setAuthRole, authPersona, setAuthPersona,
  authForm, setAuthForm, authError, authBusy, authStep,
  onSendOtp, onVerifyOtp, onChangeNumber, resendCooldown, devOtpHint,
}) {
  const roleIcon = { customer: Users, lister: Building2 };
  const catIcon = { student: BookOpen, professional: Briefcase };
  const catBlurb = authRole === "lister"
    ? { student: "Rooms, PGs & hostels near campuses", professional: "Studios, flats & co-living near workplaces" }
    : { student: "Campus-side rooms, PGs & student flatmates", professional: "WFH-ready homes & working flatmates" };
  const isLogin = authMode === "login";
  return (
    <div className="basera-app min-h-screen flex items-center justify-center px-6 py-12 relative" data-theme={darkMode ? "dark" : "light"} style={{ background: "var(--kraft)", color: "var(--ink)", fontFamily: "Inter, sans-serif" }}>
      <button type="button" onClick={() => setDarkMode((d) => !d)} className="absolute top-4 right-4 flex items-center gap-1 text-[11px] font-mono uppercase px-2.5 py-1.5" style={{ border: "1px solid color-mix(in srgb, var(--ink) 25%, transparent)", color: "var(--ink)" }}>{darkMode ? <Sun size={14} /> : <Moon size={14} />}{darkMode ? "Light" : "Dark"}</button>
      <Notice i={2} className="w-full max-w-lg p-6" style={{ transform: "rotate(-0.4deg)" }}>
        <p className="font-mono text-[11px] uppercase tracking-[0.2em] mb-1" style={{ color: "var(--marigold)" }}>Basera accounts</p>
        <h2 style={{ ...HEAD, fontSize: 30, color: "var(--ink)" }}>
          {authStep === "otp" ? "Verify your number" : isLogin ? "Log in" : "Create account"}
        </h2>

        {authStep === "phone" && (
          <>
            <div className="flex mt-4" role="tablist" aria-label="Log in or sign up" style={{ border: "1px solid color-mix(in srgb, var(--ink) 20%, transparent)", borderRadius: 6, overflow: "hidden" }}>
              {[{ id: "login", label: "Log in" }, { id: "signup", label: "Sign up" }].map(({ id, label }) => (
                <button key={id} type="button" role="tab" aria-selected={authMode === id} onClick={() => setAuthMode(id)} className="no-lift flex-1 text-xs font-mono font-bold uppercase py-2" style={{ background: authMode === id ? "var(--ink)" : "transparent", color: authMode === id ? "var(--kraft)" : "var(--ink)", borderRadius: 0 }}>{label}</button>
              ))}
            </div>

            <p className="text-[11px] font-mono uppercase tracking-wide mt-5 mb-2" style={{ color: "color-mix(in srgb, var(--ink) 55%, transparent)" }}>1 &middot; {isLogin ? "Log in as" : "I am a"}</p>
            <div className="flex gap-3" role="radiogroup" aria-label="Account type">
              {ROLES.map((r) => (
                <ChoiceCard key={r.id} name="role" selected={authRole === r.id} onClick={() => setAuthRole(r.id)} icon={roleIcon[r.id]} title={r.label} blurb={r.blurb} />
              ))}
            </div>

            <p className="text-[11px] font-mono uppercase tracking-wide mt-5 mb-2" style={{ color: "color-mix(in srgb, var(--ink) 55%, transparent)" }}>2 &middot; {authRole === "lister" ? "I list for" : "Category"}</p>
            <div className="flex gap-3" role="radiogroup" aria-label="Category">
              {CATEGORIES.map((c) => (
                <ChoiceCard key={c.id} name="persona" selected={authPersona === c.id} onClick={() => setAuthPersona(c.id)} icon={catIcon[c.id]} title={c.label} blurb={catBlurb[c.id]} />
              ))}
            </div>

            <p className="text-[11px] font-mono uppercase tracking-wide mt-5 mb-1" style={{ color: "color-mix(in srgb, var(--ink) 55%, transparent)" }}>3 &middot; Your number</p>
            <p className="text-xs mb-2" style={{ color: "color-mix(in srgb, var(--ink) 60%, transparent)" }}>
              {isLogin ? "Log in with the same account type and category you signed up with." : "We sign you in with your phone number — no email or password needed."}
            </p>
            <div className="space-y-3">
              {!isLogin && (
                <input placeholder="Full name" value={authForm.name} onChange={(e) => setAuthForm((f) => ({ ...f, name: e.target.value }))} className="w-full text-sm px-3 py-2" style={{ border: "1px dashed color-mix(in srgb, var(--ink) 30%, transparent)", background: "var(--kraft)" }} />
              )}
              <input type="tel" inputMode="tel" autoComplete="tel" placeholder="Phone number (e.g. 98765 43210)" value={authForm.phone} onChange={(e) => setAuthForm((f) => ({ ...f, phone: e.target.value }))} className="w-full text-sm px-3 py-2 font-mono" style={{ border: "1px dashed color-mix(in srgb, var(--ink) 30%, transparent)", background: "var(--kraft)" }} />
              {authError && <p role="alert" className="text-sm" style={{ color: "var(--stamp)" }}>{authError}</p>}
              <button type="button" disabled={authBusy} onClick={onSendOtp} className="w-full py-2.5 text-sm font-bold uppercase tracking-wide disabled:opacity-50 flex items-center justify-center gap-2" style={{ background: "var(--marigold)", color: "#1E2A38" }}>{authBusy ? <Loader2 size={16} className="spin" /> : <LogIn size={16} />} Send OTP &middot; {roleLabel(authRole)} / {personaLabel(authPersona)}</button>
            </div>
          </>
        )}

        {authStep === "otp" && (
          <>
            <p className="inline-flex items-center gap-1.5 text-[11px] font-mono font-bold uppercase mt-3 px-2 py-1" style={{ background: "color-mix(in srgb, var(--marigold) 16%, transparent)", color: "var(--ink)", borderRadius: 4 }}>{isLogin ? "Logging in as" : "Signing up as"} {describeAccount({ role: authRole, persona: authPersona })}</p>
            <p className="text-sm mt-2" style={{ color: "color-mix(in srgb, var(--ink) 65%, transparent)" }}>Enter the 6-digit code sent to <span className="font-mono font-bold">{authForm.phone}</span>.</p>
            <div className="space-y-3 mt-5">
              <input type="text" inputMode="numeric" pattern="\d*" maxLength={6} autoFocus placeholder="••••••" value={authForm.otp} onChange={(e) => setAuthForm((f) => ({ ...f, otp: e.target.value.replace(/\D/g, "").slice(0, 6) }))} className="w-full text-center text-2xl tracking-[0.5em] font-mono px-3 py-3" style={{ border: "1px dashed color-mix(in srgb, var(--ink) 30%, transparent)", background: "var(--kraft)" }} />
              {authError && <p role="alert" className="text-sm" style={{ color: "var(--stamp)" }}>{authError}</p>}
              <button type="button" disabled={authBusy || authForm.otp.length !== 6} onClick={onVerifyOtp} className="w-full py-2.5 text-sm font-bold uppercase tracking-wide disabled:opacity-50 flex items-center justify-center gap-2" style={{ background: "var(--marigold)", color: "#1E2A38" }}>{authBusy ? <Loader2 size={16} className="spin" /> : <CheckCircle2 size={16} />} Verify &amp; continue</button>
              <div className="flex items-center justify-between text-xs font-mono">
                <button type="button" onClick={onChangeNumber} className="underline" style={{ color: "color-mix(in srgb, var(--ink) 55%, transparent)" }}>Change number / type</button>
                <button type="button" disabled={resendCooldown > 0 || authBusy} onClick={onSendOtp} className="underline disabled:no-underline disabled:opacity-50" style={{ color: "color-mix(in srgb, var(--ink) 55%, transparent)" }}>{resendCooldown > 0 ? `Resend in ${resendCooldown}s` : "Resend OTP"}</button>
              </div>
            </div>
            {devOtpHint && (
              <p className="text-[11px] mt-4 font-mono px-2.5 py-2" style={{ background: "var(--kraft)", color: "color-mix(in srgb, var(--ink) 55%, transparent)" }}>
                Demo mode — no SMS provider is connected, so we can't text you. Your code: <span className="font-bold">{devOtpHint}</span> (a real deployment would send this by SMS and never show it here).
              </p>
            )}
          </>
        )}
      </Notice>
    </div>
  );
}

function SubscriptionGate({ darkMode, currentUser, subscription, plans, subBusy, onActivate, onLogout }) {
  return (
    <div className="basera-app min-h-screen px-6 py-10" data-theme={darkMode ? "dark" : "light"} style={{ background: "var(--kraft)", color: "var(--ink)", fontFamily: "Inter, sans-serif" }}>
      <div className="max-w-2xl mx-auto">
        <SectionTitle sub={`Hi ${currentUser.name} — your ${currentUser.role === "lister" ? "owner" : "tenant"} subscription is inactive. Choose a plan to continue (saved to your account in our database).`}>Activate subscription</SectionTitle>
        <div className="grid sm:grid-cols-2 gap-5">
          {plans.map((plan, i) => (
            <Notice key={plan.id} i={i} className="p-5 flex flex-col">
              <p style={{ ...HEAD, fontSize: 20 }}>{plan.name}</p>
              <p className="font-mono text-2xl font-bold mt-2" style={{ color: "var(--ink)" }}>₹{plan.price.toLocaleString("en-IN")}{plan.recurring ? <span className="text-sm font-normal">/mo</span> : <span className="text-sm font-normal">/yr</span>}</p>
              <p className="text-sm mt-2 flex-1" style={{ color: "color-mix(in srgb, var(--ink) 70%, transparent)" }}>{plan.blurb}</p>
              <button type="button" disabled={subBusy} onClick={() => onActivate(plan)} className="w-full mt-4 py-2 text-xs font-bold uppercase disabled:opacity-50" style={{ background: "var(--marigold)", color: "var(--ink)" }}>{subBusy ? "Saving…" : "Subscribe (demo)"}</button>
            </Notice>
          ))}
        </div>
        <button type="button" onClick={onLogout} className="mt-8 flex items-center gap-2 text-sm font-mono" style={{ color: "var(--stamp)" }}><LogOut size={14} /> Log out</button>
      </div>
    </div>
  );
}

// Popup shown when a non-subscribed tenant tries to open the property map / direct
// owner contact. Distinct from SubscriptionGate (which fully blocks owners from
// publishing) — this is a dismissible modal, browsing continues either way.
function MapSubscribeModal({ open, onClose, plans, subBusy, onActivate }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[70] flex items-end sm:items-center justify-center p-0 sm:p-6" style={{ background: "rgba(20,26,34,0.6)" }} onClick={onClose}>
      <div className="w-full sm:max-w-md overflow-hidden" style={{ background: "var(--paper)", borderRadius: 4, boxShadow: "0 20px 40px -10px rgba(0,0,0,0.4)" }} onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-4 flex items-center justify-between" style={{ background: "var(--panel)" }}>
          <span className="flex items-center gap-2 text-xs font-mono font-bold uppercase tracking-wider" style={{ color: "var(--panel-text)" }}><Navigation size={15} /> Unlock property maps</span>
          <button onClick={onClose} aria-label="Close"><X size={18} style={{ color: "var(--panel-text)" }} /></button>
        </div>
        <div className="p-5">
          <p className="text-sm" style={{ color: "color-mix(in srgb, var(--ink) 75%, transparent)" }}>See the exact property/society location on the map and connect directly with the owner. No broker — direct owner contact.</p>
          <div className="grid sm:grid-cols-2 gap-3 mt-4">
            {plans.map((plan, i) => (
              <Notice key={plan.id} i={i} className="p-4 flex flex-col">
                <p style={{ ...HEAD, fontSize: 17 }}>{plan.name}</p>
                <p className="font-mono text-xl font-bold mt-1.5" style={{ color: "var(--ink)" }}>₹{plan.price.toLocaleString("en-IN")}{plan.recurring ? <span className="text-xs font-normal">/mo</span> : <span className="text-xs font-normal">/yr</span>}</p>
                <p className="text-xs mt-1.5 flex-1" style={{ color: "color-mix(in srgb, var(--ink) 65%, transparent)" }}>{plan.blurb}</p>
                <button type="button" disabled={subBusy} onClick={() => onActivate(plan)} className="w-full mt-3 py-2 text-xs font-bold uppercase disabled:opacity-50" style={{ background: "var(--marigold)", color: "var(--ink)" }}>{subBusy ? "Saving…" : "Subscribe & unlock"}</button>
              </Notice>
            ))}
          </div>
          <button type="button" onClick={onClose} className="w-full mt-4 text-xs font-mono underline" style={{ color: "color-mix(in srgb, var(--ink) 55%, transparent)" }}>Continue with estimated location</button>
        </div>
      </div>
    </div>
  );
}

// ---------- main ----------

function BaseraThemeStyles() {
  return (
    <style>{`
        :root {
          --ink: #1E2A38; --kraft: #EDE3CF; --paper: #FFFDF7; --marigold: #E9A23B; --stamp: #B23A2E; --sage: #4E7052; --panel: #1E2A38; --panel-text: #EDE3CF;
          --hover-glow: rgba(233, 162, 59, 0.22);
          --hover-glow-lg: 0 0 20px rgba(233, 162, 59, 0.25), 0 8px 24px -6px rgba(30, 42, 56, 0.15);
          --hover-card-border: rgba(233, 162, 59, 0.45);
          --btn-hover-brightness: 1.05;
        }
        .basera-app[data-theme='dark'] {
          --ink: #EDE3CF; --kraft: #141A22; --paper: #222933; --marigold: #F0B255; --stamp: #E2695C; --sage: #86BF8A; --panel: #0D1218; --panel-text: #EDE3CF;
          --hover-glow: rgba(240, 178, 85, 0.35);
          --hover-glow-lg: 0 0 24px rgba(240, 178, 85, 0.3), 0 10px 28px -6px rgba(0, 0, 0, 0.6);
          --hover-card-border: rgba(240, 178, 85, 0.6);
          --btn-hover-brightness: 1.15;
        }
        html, body { margin: 0; background: #EDE3CF; }
        html[data-theme='dark'], html[data-theme='dark'] body { background: #141A22; }
        .basera-hero { padding-top: calc(2.5rem + env(safe-area-inset-top, 0px)) !important; }
        .basera-footer { padding-bottom: calc(2rem + env(safe-area-inset-bottom, 0px)) !important; }

        /* base colour transitions (zero specificity so component rules below win) */
        :where(.basera-app, .basera-app *) { transition: background-color 0.2s cubic-bezier(0.16, 1, 0.3, 1), border-color 0.2s cubic-bezier(0.16, 1, 0.3, 1), color 0.2s cubic-bezier(0.16, 1, 0.3, 1); }

        .basera-app[data-theme='dark'] select:not(.hero-select) { background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%23EDE3CF'/%3E%3C/svg%3E") !important; }
        .basera-app[data-theme='dark'] .stamp-surface { background: rgba(34,41,51,0.9) !important; }
        .font-mono { font-family: 'Space Mono', monospace; }
        button { cursor: pointer; }
        input[type=range] { accent-color: var(--marigold); }
        select { background-color: transparent; appearance: none; -webkit-appearance: none; -moz-appearance: none;
          background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%231E2A38'/%3E%3C/svg%3E");
          background-repeat: no-repeat; background-position: right 2px center; padding-right: 18px; }
        select.hero-select { background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%23EDE3CF'/%3E%3C/svg%3E"); }
        select option, select optgroup { color: #1E2A38; }
        @keyframes spin { to { transform: rotate(360deg); } }
        .spin { animation: spin 1s linear infinite; }
        *:focus-visible { outline: 2px solid var(--marigold); outline-offset: 3px; }

        /* ---- Primary category nav: glow + elevation ---- */
        .category-pill { position: relative; padding: 6px 14px; border-radius: 6px; transition: color 220ms ease, background-color 220ms ease, box-shadow 250ms ease, transform 200ms ease; }
        .category-pill:hover { transform: translateY(-2px); background: rgba(233, 162, 59, 0.12); box-shadow: 0 0 16px var(--hover-glow), 0 2px 8px -2px rgba(0, 0, 0, 0.15); }
        .category-pill.active-tab { background: rgba(233, 162, 59, 0.18); box-shadow: 0 0 12px var(--hover-glow); border-bottom: 2px solid var(--marigold); }

        /* ---- Cursor-tracked card glow (pinned-notice cards keep their tilt until hovered) ---- */
        .notice-card { border-radius: 6px; transform: rotate(var(--tilt, 0deg));
          transition: transform 260ms cubic-bezier(0.16, 1, 0.3, 1), box-shadow 260ms cubic-bezier(0.16, 1, 0.3, 1), border-color 220ms ease, background-color 0.2s; }
        .notice-card::before { content: ""; position: absolute; inset: 0; border-radius: inherit; pointer-events: none; z-index: 10; opacity: 0; transition: opacity 250ms ease;
          background: radial-gradient(240px circle at var(--mouse-x, -999px) var(--mouse-y, -999px), var(--hover-glow), transparent 75%); }
        .notice-card:hover::before, .notice-card:focus-visible::before { opacity: 1; }
        .notice-card:hover { transform: rotate(0deg) translateY(-3px) scale(1.008); box-shadow: var(--hover-glow-lg) !important; border-color: var(--hover-card-border) !important; }
        .card-img-zoom { transition: transform 450ms cubic-bezier(0.2, 0.8, 0.2, 1); }
        .notice-card:hover .card-img-zoom { transform: scale(1.05); }
        .card-title { transition: color 200ms ease; }
        .notice-card:hover .card-title { color: var(--marigold) !important; }

        /* ---- Buttons ---- */
        .basera-app button { transition: transform 180ms ease, box-shadow 220ms ease, filter 180ms ease, background-color 180ms ease, color 180ms ease, border-color 180ms ease; }
        .basera-app button:not(:disabled):not(.no-lift):not(.category-pill):not(.underline):hover { transform: translateY(-1.5px); box-shadow: 0 4px 14px var(--hover-glow); filter: brightness(var(--btn-hover-brightness)); }
        .basera-app button:not(:disabled):not(.no-lift):not(.category-pill):active { transform: translateY(0) scale(0.99); }
        .basera-app button.underline:hover, .link-interactive:hover { color: var(--marigold) !important; }
        .icon-hover-btn { border-radius: 999px; }
        .basera-app .icon-hover-btn:not(:disabled):hover { transform: scale(1.1); filter: drop-shadow(0 0 6px var(--hover-glow)); box-shadow: none; color: var(--marigold) !important; }

        /* ---- Form fields ---- */
        .basera-app select:hover, .basera-app input:not([type=range]):not([type=checkbox]):hover, .basera-app textarea:hover { box-shadow: 0 1px 0 0 var(--hover-card-border); }
        .basera-app select:focus, .basera-app input:not([type=range]):not([type=checkbox]):focus, .basera-app textarea:focus { outline: none; box-shadow: 0 2px 0 0 var(--marigold); }
        .search-box:focus-within { border-color: var(--marigold) !important; box-shadow: 0 0 0 3px var(--hover-glow); }
        .search-box input { box-shadow: none !important; }

        @media (prefers-reduced-motion: reduce) {
          *, *::before, *::after { transition: none !important; animation: none !important; }
          .notice-card:hover { transform: rotate(var(--tilt, 0deg)) !important; }
          .basera-app button:hover, .category-pill:hover { transform: none !important; }
          .notice-card:hover .card-img-zoom { transform: none; }
        }
      `}</style>
  );
}

export default function BaseraApp() {
  const [darkMode, setDarkMode] = useState(() => {
    try {
      const saved = localStorage.getItem("basera-theme");
      if (saved) return saved === "dark";
      return !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
    } catch (e) { return false; }
  });
  const [selectedCity, setSelectedCity] = useState("Delhi NCR");
  const [tab, setTab] = useState("properties");
  const [nearbyActive, setNearbyActive] = useState(false);
  const [userGeo, setUserGeo] = useState(null);
  const [geoError, setGeoError] = useState("");

  useEffect(() => {
    try { localStorage.setItem("basera-theme", darkMode ? "dark" : "light"); } catch (e) {}
    document.documentElement.setAttribute("data-theme", darkMode ? "dark" : "light");
  }, [darkMode]);

  // Feeds the cursor position into the hovered card so its ambient glow follows the pointer.
  useEffect(() => {
    const onMove = (e) => {
      const card = e.target?.closest?.(".notice-card");
      if (!card) return;
      const r = card.getBoundingClientRect();
      card.style.setProperty("--mouse-x", `${e.clientX - r.left}px`);
      card.style.setProperty("--mouse-y", `${e.clientY - r.top}px`);
    };
    document.addEventListener("mousemove", onMove, { passive: true });
    return () => document.removeEventListener("mousemove", onMove);
  }, []);

  const [favorites, setFavorites] = useState(() => baseraDb.loadJson("data:favorites", []));
  useEffect(() => { baseraDb.saveJson("data:favorites", favorites); }, [favorites]);
  function toggleFavorite(id) { setFavorites((f) => (f.includes(id) ? f.filter((x) => x !== id) : [...f, id])); }


  // ---- auth (phone + OTP) + subscription (mock "database" via window.storage, shared across users of this artifact) ----
  const [authChecked, setAuthChecked] = useState(false);
  const [currentUser, setCurrentUser] = useState(null); // { phone, name, role, persona }
  // Category (student | professional) is fixed by the account — it is chosen at sign-up, not toggled in the UI.
  const persona = normalizePersona(currentUser?.persona);
  const isOwner = normalizeRole(currentUser?.role) === "lister";
  const [authMode, setAuthMode] = useState("login"); // 'login' | 'signup'
  const [authRole, setAuthRole] = useState("customer"); // 'customer' (tenant) | 'lister' (owner)
  const [authPersona, setAuthPersona] = useState("student"); // 'student' | 'professional'
  const [authStep, setAuthStep] = useState("phone"); // 'phone' | 'otp'
  const [authForm, setAuthForm] = useState({ name: "", phone: "", otp: "" });
  const [authError, setAuthError] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const [subscription, setSubscription] = useState(null); // { active, plan, price }
  const [subBusy, setSubBusy] = useState(false);
  const [otpSession, setOtpSession] = useState(null); // { phone, code, expiresAt, attempts } — memory only, never persisted
  const [resendCooldown, setResendCooldown] = useState(0);
  const [devOtpHint, setDevOtpHint] = useState("");

  useEffect(() => {
    if (resendCooldown <= 0) return;
    const t = setInterval(() => setResendCooldown((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(t);
  }, [resendCooldown]);

  useEffect(() => {
    api("/me").then(({ account: acc }) => { baseraDb.setSessionPhone(acc.phone); setCurrentUser({ phone: acc.phone, name: acc.name, role: normalizeRole(acc.role), persona: normalizePersona(acc.persona) }); setSubscription({ active: acc.subscriptionActive, plan: acc.plan }); }).catch(() => {}).finally(() => setAuthChecked(true));
  }, []); // eslint-disable-line

  async function loadAccount(phone) {
    try { return (await api("/auth/account", { method: "POST", body: JSON.stringify({ phone }) })).account; } catch { return null; }
  }
  async function saveAccount(phone, data) {
    return data;
  }

  // Step 1: request an OTP for the entered phone number. Rate-limited via resendCooldown;
  // never consumes/creates an account, so it's always safe to call.
  async function handleSendOtp() {
    setAuthError(""); setAuthBusy(true);
    if (resendCooldown > 0) { setAuthBusy(false); return; }
    const phone = normalizePhone(authForm.phone);
    if (!isValidPhone(authForm.phone)) { setAuthError("Enter a valid phone number."); setAuthBusy(false); return; }
    if (authMode === "signup" && !authForm.name.trim()) { setAuthError("Enter your name."); setAuthBusy(false); return; }
    // For login, make sure an account exists before bothering to text a code.
    if (authMode === "login") {
      const existing = await loadAccount(phone);
      const match = checkLoginMatch(existing, authRole, authPersona);
      if (!match.ok) { setAuthError(match.reason); setAuthBusy(false); return; }
    } else {
      const existing = await loadAccount(phone);
      if (existing) { setAuthError("An account with this number already exists — log in instead."); setAuthBusy(false); return; }
    }
    window.__baseraAuthMode = authMode; window.__baseraSignupName = authForm.name.trim(); window.__baseraRole = authRole; window.__baseraPersona = authPersona;
    let otp;
    try { otp = await sendOtpToPhone(phone); } catch (error) { setAuthError(error.message); setAuthBusy(false); return; }
    const { code, expiresAt } = otp;
    setOtpSession({ phone, code, expiresAt, attempts: 0 });
    setAuthForm((f) => ({ ...f, phone, otp: "" }));
    setDevOtpHint(code); // demo-only: shown because no real SMS backend is connected (see sendOtpToPhone)
    setAuthStep("otp");
    setResendCooldown(OTP_RESEND_COOLDOWN_S);
    setAuthBusy(false);
  }

  // Step 2: verify the code server-side (simulated), then create or log into the account.
  async function handleVerifyOtp() {
    setAuthError(""); setAuthBusy(true);
    window.__baseraAuthMode = authMode; window.__baseraSignupName = authForm.name.trim(); window.__baseraRole = authRole; window.__baseraPersona = authPersona;
    const result = await verifyOtpWithBackend(otpSession, authForm.otp.trim());
    if (!result.ok) {
      setOtpSession((s) => (s ? { ...s, attempts: s.attempts + 1 } : s));
      setAuthError(result.reason);
      setAuthBusy(false);
      return;
    }
    const phone = otpSession.phone;
    const existing = result.account || await loadAccount(phone);
    if (authMode === "signup") {
      const acc = { name: authForm.name.trim(), phone, phoneVerified: true, role: authRole, persona: authPersona, subscriptionActive: false, plan: null };
      // The API creates the account after verifying the OTP.
      baseraDb.setSessionPhone(phone);
      setCurrentUser({ phone, name: acc.name, role: acc.role, persona: acc.persona });
      setSubscription({ active: false, plan: null });
    } else {
      const match = checkLoginMatch(existing, authRole, authPersona);
      if (!match.ok) { setAuthError(match.reason); setAuthBusy(false); return; }
      baseraDb.setSessionPhone(phone);
      setCurrentUser({ phone, name: existing.name, role: normalizeRole(existing.role), persona: normalizePersona(existing.persona) });
      setSubscription({ active: !!existing.subscriptionActive, plan: existing.plan || null });
    }
    setOtpSession(null);
    setDevOtpHint("");
    setAuthStep("phone");
    setAuthForm({ name: "", phone: "", otp: "" });
    setAuthBusy(false);
  }

  function handleChangeNumber() {
    setOtpSession(null);
    setDevOtpHint("");
    setAuthError("");
    setResendCooldown(0);
    setAuthStep("phone");
    setAuthForm((f) => ({ ...f, otp: "" }));
  }

  async function refreshSubscriptionFromDb() {
    if (!currentUser?.phone) return;
    const acc = await loadAccount(currentUser.phone);
    if (acc) setSubscription({ active: !!acc.subscriptionActive, plan: acc.plan || null });
  }

  function requestNearby() {
    setGeoError("");
    if (!navigator.geolocation) { setGeoError("Geolocation is not available in this browser."); return; }
    navigator.geolocation.getCurrentPosition(
      (pos) => { setUserGeo({ lat: pos.coords.latitude, lng: pos.coords.longitude }); setNearbyActive(true); },
      () => setGeoError("Could not read your location — allow location access or browse by area instead."),
      { enableHighAccuracy: false, timeout: 12000 },
    );
  }

  function logout() {
    api("/auth/logout", { method: "POST" }).catch(() => {});
    try { localStorage.removeItem("basera:token"); } catch {}
    baseraDb.setSessionPhone(null);
    setCurrentUser(null);
    setSubscription(null);
    setAuthForm({ name: "", phone: "", otp: "" });
    setAuthStep("phone");
    setAuthMode("login");
    setAuthRole("customer");
    setAuthPersona("student");
    setOtpSession(null);
    setDevOtpHint("");
    setResendCooldown(0);
    setAuthError("");
    setTab("properties");
  }

  async function activateSubscription(plan) {
    setSubBusy(true);
    try { await api("/subscription", { method: "POST", body: JSON.stringify({ plan: plan.name, price: plan.price }) }); setSubscription({ active: true, plan: plan.name }); }
    catch (error) { setAuthError(error.message); }
    finally { setSubBusy(false); }
  }

  const [properties, setProperties] = useState(() => baseraDb.loadProperties(SEED_PROPERTIES).map((p) => (p.ac === undefined && SEED_PROPERTIES.find((sp) => sp.id === p.id)?.ac ? { ...p, ac: SEED_PROPERTIES.find((sp) => sp.id === p.id).ac } : p)));
  useEffect(() => { baseraDb.saveProperties(properties); }, [properties]); // listings (incl. owner photos) survive refresh
  useEffect(() => { api("/properties").then(({ properties: remote }) => { if (remote?.length) setProperties(remote); }).catch(() => {}); }, []);
  const [filters, setFilters] = useState({ area: "All", type: "All", gender: "Any", maxRent: 22000, verifiedOnly: false, wfhOnly: false, ac: "Any", query: "", savedOnly: false });
  const [selected, setSelected] = useState(null);
  const [galleryIndex, setGalleryIndex] = useState(0);
  const [mapPaywallOpen, setMapPaywallOpen] = useState(false);
  useEffect(() => { setGalleryIndex(0); setMapPaywallOpen(false); }, [selected?.id]);
  const [reviewDraft, setReviewDraft] = useState({ rating: 0, text: "" });
  const [reserved, setReserved] = useState({});
  const [payment, setPayment] = useState(null);

  const [profile, setProfile] = useState({ area: "Kamla Nagar", budget: 9000, gender: "Female", food: "Veg", sleep: "Early bird", clean: "Very tidy", smoking: "No", study: "Quiet focus" });
  const [showMatches, setShowMatches] = useState(false);
  const [aiInsights, setAiInsights] = useState({});

  const [listStep, setListStep] = useState("form");
  const [newListing, setNewListing] = useState({
    title: "", area: "Kamla Nagar", rent: 9000, type: "2-sharing", gender: "Any", tenantFor: "any", food: false, wifi: false, notes: "", location: null,
    ac: "", bhk: "Not specified", dimensionValue: "", dimensionType: "Carpet Area", photos: [],
  });
  const [photoUploadError, setPhotoUploadError] = useState("");
  // An owner's category sets the default "preferred tenants" on new listings.
  useEffect(() => { if (isOwner) setNewListing((l) => ({ ...l, tenantFor: audienceForPersona(persona) })); }, [isOwner, persona]);

  function handleListingPhotoUpload(files) {
    setPhotoUploadError("");
    const list = Array.from(files || []);
    if (!list.length) return;
    if ((newListing.photos.length + list.length) > 10) { setPhotoUploadError("You can upload up to 10 photos per listing."); return; }
    list.forEach((file) => {
      if (!file.type.startsWith("image/")) { setPhotoUploadError("Only image files can be uploaded."); return; }
      if (file.size > 12 * 1024 * 1024) { setPhotoUploadError("Each photo must be under 12 MB."); return; }
      // Downscale + re-encode so many photos fit inside the browser's ~5 MB localStorage quota.
      const reader = new FileReader();
      reader.onload = () => {
        const img = new Image();
        img.onload = () => {
          const MAX = 1000;
          const scale = Math.min(1, MAX / Math.max(img.width, img.height));
          const c = document.createElement("canvas");
          c.width = Math.max(1, Math.round(img.width * scale));
          c.height = Math.max(1, Math.round(img.height * scale));
          c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
          const dataUrl = c.toDataURL("image/jpeg", 0.72);
          setNewListing((l) => ({ ...l, photos: [...l.photos, { id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, dataUrl, caption: file.name.replace(/\.[a-zA-Z0-9]+$/, "") }] }));
        };
        img.onerror = () => setPhotoUploadError("That image couldn't be read. Try a JPG or PNG.");
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }
  function removeListingPhoto(id) {
    setNewListing((l) => ({ ...l, photos: l.photos.filter((p) => p.id !== id) }));
  }
  function handleDimensionChange(raw) {
    // Reject negative or otherwise invalid area values.
    if (raw === "") { setNewListing((l) => ({ ...l, dimensionValue: "" })); return; }
    const n = Number(raw);
    if (Number.isNaN(n) || n < 0) return;
    setNewListing((l) => ({ ...l, dimensionValue: raw }));
  }
  const [checklist, setChecklist] = useState({ id: false, ownership: false, photos: false, address: false });
  const [myListingIds, setMyListingIds] = useState([]);

  const [collegeEmail, setCollegeEmail] = useState("");
  const [officeEmail, setOfficeEmail] = useState("");
  const [partner, setPartner] = useState(null);
  useEffect(() => { setPartner(null); setCollegeEmail(""); setOfficeEmail(""); }, [currentUser?.phone, persona]);
  const [studentName, setStudentName] = useState("");
  const [agreementFor, setAgreementFor] = useState(null);
  const [signedIds, setSignedIds] = useState({});
  const [aiRec, setAiRec] = useState({ loading: false, text: "", error: false });

  const [livingSub, setLivingSub] = useState("maintenance");
  useEffect(() => {
    const studentTabs = ["maintenance", "movers", "furniture", "insurance", "community"];
    const proTabs = ["maintenance", "movers", "coworking", "insurance"];
    const allowed = persona === "student" ? studentTabs : proTabs;
    if (!allowed.includes(livingSub)) setLivingSub(allowed[0]);
  }, [persona, livingSub]);
  const [maintReqs, setMaintReqs] = useState([]);
  const [maintDraft, setMaintDraft] = useState({ propertyId: SEED_PROPERTIES[0].id, issueType: "Plumbing", urgency: "Medium", description: "" });
  const [moverBookings, setMoverBookings] = useState([]);
  const [moverDraft, setMoverDraft] = useState({ moverId: MOVERS[0].id, moveType: "local", date: "" });
  const [cart, setCart] = useState({});
  const [rentedItems, setRentedItems] = useState([]);
  const [purchasedPlan, setPurchasedPlan] = useState(null);
  const [posts, setPosts] = useState(SEED_POSTS);
  useEffect(() => { api("/posts").then(({ posts: remote }) => { if (remote?.length) setPosts(remote); }).catch(() => {}); }, []);
  const [postDraft, setPostDraft] = useState({ text: "", tag: "General" });

  useEffect(() => {
    if (currentUser && !navIdsForRole(currentUser.role).includes(tab)) setTab("properties");
  }, [currentUser, tab]);

  const cityAreas = CITIES[selectedCity].areas;
  const distLabel = persona === "student" ? "from campus" : "from city center";

  useEffect(() => {
    setFilters((f) => ({ ...f, area: "All" }));
    setNewListing((l) => ({ ...l, area: cityAreas[0] || l.area }));
  }, [selectedCity]); // eslint-disable-line

  const filteredProps = useMemo(() => {
    const center = CITY_CENTER[selectedCity];
    return properties
      .filter((p) => {
        if (p.city !== selectedCity) return false;
        const audience = p.tenantFor || "any";
        if (persona === "student" && audience === "professionals") return false;
        if (persona === "professional" && audience === "students") return false;
        if (filters.area !== "All" && p.area !== filters.area) return false;
        if (filters.type !== "All" && p.type !== filters.type) return false;
        if (filters.gender !== "Any" && p.gender !== "Any" && p.gender !== filters.gender) return false;
        if (p.rent > filters.maxRent) return false;
        if (!matchesAcFilter(p, filters.ac)) return false;
        const q = (filters.query || "").trim().toLowerCase();
        if (q && !`${p.title} ${p.area} ${p.city} ${p.type} ${p.notes || ""} ${p.locationLabel || ""}`.toLowerCase().includes(q)) return false;
        if (filters.savedOnly && !favorites.includes(p.id)) return false;
        if (filters.verifiedOnly && p.status !== "verified") return false;
        if (filters.wfhOnly && !(p.wifi && (p.type.includes("Single") || p.type.toLowerCase().includes("co-living") || p.type.includes("Studio")))) return false;
        return true;
      })
      .map((p) => {
        let km = p.dist;
        if (nearbyActive && userGeo && p.lat != null && p.lng != null) km = haversineKm(userGeo.lat, userGeo.lng, p.lat, p.lng);
        else if (nearbyActive && userGeo && center) km = haversineKm(userGeo.lat, userGeo.lng, center.lat, center.lng) + (p.dist || 0);
        return { ...p, displayDist: km };
      })
      .sort((a, b) => {
        if (nearbyActive && userGeo) return (a.displayDist ?? a.dist) - (b.displayDist ?? b.dist);
        return (b.premium - a.premium) || ((avgRating(b.reviews) || 0) - (avgRating(a.reviews) || 0));
      });
  }, [properties, filters, selectedCity, persona, nearbyActive, userGeo, favorites]);

  const roomTypes = useMemo(() => ["All", ...new Set(SEED_PROPERTIES.map((p) => p.type))], []);

  const matches = useMemo(() => {
    const pool = persona === "professional" ? "professional" : "student";
    return CANDIDATES
      .filter((c) => c.city === selectedCity)
      .filter((c) => (c.personaType || "student") === pool)
      .filter((c) => profile.gender === "Any" || c.gender === "Any" || c.gender === profile.gender)
      .map((c) => ({ ...c, score: matchScore(profile, c) }))
      .sort((a, b) => b.score - a.score);
  }, [profile, selectedCity, persona]);

  const myListings = properties.filter((p) => myListingIds.includes(p.id) || (p.ownerPhone && p.ownerPhone === currentUser?.phone));
  const checklistDone = Object.values(checklist).every(Boolean);
  const cartTotal = Object.entries(cart).reduce((sum, [id, qty]) => sum + (FURNITURE.find((f) => f.id === id)?.price || 0) * qty, 0);
  const cartCount = Object.values(cart).reduce((a, b) => a + b, 0);

  async function submitReview() {
    if (!reviewDraft.rating || !selected) return;
    let review = { id: Date.now(), author: currentUser.name, rating: reviewDraft.rating, text: reviewDraft.text || "No comment left.", date: "Just now" };
    try { const { listing } = await api(`/properties/${selected.id}/review`, { method: "PATCH", body: JSON.stringify(review) }); review = listing.reviews[0]; } catch (error) { setAuthError(error.message); return; }
    setProperties((prev) => prev.map((p) => (p.id === selected.id ? { ...p, reviews: [review, ...p.reviews] } : p)));
    setSelected((s) => ({ ...s, reviews: [review, ...s.reviews] }));
    setReviewDraft({ rating: 0, text: "" });
  }

  async function submitListing() {
    const loc = newListing.location;
    const payload = {
      city: selectedCity, ...newListing, rent: +newListing.rent, dist: 0.5,
      dimensionValue: newListing.dimensionValue ? +newListing.dimensionValue : null,
      lat: loc?.lat ?? null, lng: loc?.lng ?? null, locationLabel: loc?.label || null,
      ownerName: currentUser.name, ownerPhone: currentUser.phone,
      status: "pending", premium: false, reviews: [],
    };
    let listing;
    try { ({ listing } = await api("/properties", { method: "POST", body: JSON.stringify(payload) })); } catch (error) { setAuthError(error.message); return; }
    const id = listing.id;
    setProperties((prev) => [listing, ...prev]);
    setMyListingIds((prev) => [id, ...prev]);
    setNewListing({ title: "", area: cityAreas[0] || "Kamla Nagar", rent: 9000, type: "2-sharing", gender: "Any", tenantFor: audienceForPersona(persona), food: false, wifi: false, notes: "", location: null, ac: "", bhk: "Not specified", dimensionValue: "", dimensionType: "Carpet Area", photos: [] });
    setListStep("done");
  }

  async function verifyListing(id) { try { const { listing } = await api(`/properties/${id}/verify`, { method: "PATCH" }); setProperties((prev) => prev.map((p) => p.id === id ? listing : p)); } catch (e) { setAuthError(e.message); } }
  function boostToPremium(id) { setPayment({ label: "Boost this listing to Featured for 30 days", amount: PREMIUM_FEE, successText: "Your listing is now Featured and pinned to the top of search results.", onDone: async () => { try { const { listing } = await api(`/properties/${id}/boost`, { method: "PATCH" }); setProperties((prev) => prev.map((p) => p.id === id ? listing : p)); } catch (e) { setAuthError(e.message); } } }); }
  function reserveRoom(property) {
    const amount = partner ? 0 : TOKEN_AMOUNT;
    setPayment({ label: partner ? `Reserve with your ${partner.name} discount` : "Pay a refundable token to reserve this room", amount, successText: "Reserved — the owner will confirm within 24 hours. Next, sign your digital rental agreement.", onDone: () => { setReserved((prev) => ({ ...prev, [property.id]: true })); setAgreementFor(property); } });
  }
  function verifyCollegeEmail() {
    const domain = collegeEmail.split("@")[1]?.toLowerCase().trim();
    const match = PARTNER_COLLEGES.find((c) => domain && (domain === c.domain || domain.endsWith("." + c.domain)));
    setPartner(match ? { ...match, kind: "college" } : null);
  }
  function verifyOfficeEmail() {
    const domain = officeEmail.split("@")[1]?.toLowerCase().trim();
    const match = PARTNER_COMPANIES.find((c) => domain && (domain === c.domain || domain.endsWith("." + c.domain)));
    setPartner(match ? { ...match, kind: "company" } : null);
  }

  async function getMatchInsight(candidate) {
    setAiInsights((prev) => ({ ...prev, [candidate.id]: { loading: true } }));
    try {
      const prompt = `You help a housing app explain why two people might make good roommates. Person A wants: area ${profile.area}, budget ₹${profile.budget}, food ${profile.food}, sleep schedule ${profile.sleep}, tidiness ${profile.clean}, smoking ${profile.smoking}, ${persona === "student" ? "study" : "work"} style ${profile.study}. Person B: area ${candidate.area}, budget ₹${candidate.budget}, food ${candidate.food}, sleep schedule ${candidate.sleep}, tidiness ${candidate.clean}, smoking ${candidate.smoking}, study/work style ${candidate.study}. In under 35 words, write a warm, specific, plain-English note to Person A about why they might get along with Person B, mentioning one real friction point to check on if relevant. No headers, no markdown.`;
      const text = await askClaude(prompt);
      setAiInsights((prev) => ({ ...prev, [candidate.id]: { loading: false, text } }));
    } catch (e) { setAiInsights((prev) => ({ ...prev, [candidate.id]: { loading: false, error: true } })); }
  }

  async function getAIRecommendation() {
    setAiRec({ loading: true, text: "", error: false });
    try {
      const listSummary = filteredProps.slice(0, 8).map((p) => `${p.title} — ${p.area}, ₹${p.rent}/mo, ${p.type}, rating ${avgRating(p.reviews) || "unrated"}`).join("; ");
      const prompt = `A ${persona === "student" ? "student" : "young working professional"} is house-hunting in ${selectedCity}. Their profile: preferred area ${profile.area}, budget around ₹${profile.budget}/month, food preference ${profile.food}. Available listings: ${listSummary}. In under 45 words, recommend one or two listings by name and briefly say why they fit this person, in a warm plain-English tone. No headers, no markdown, no bullet points.`;
      const text = await askClaude(prompt);
      setAiRec({ loading: false, text, error: false });
    } catch (e) { setAiRec({ loading: false, text: "", error: true }); }
  }

  function submitMaintenance() {
    if (!maintDraft.description) return;
    const property = properties.find((p) => p.id === maintDraft.propertyId);
    setMaintReqs((prev) => [{ id: Date.now(), propertyTitle: property?.title || "Property", issueType: maintDraft.issueType, urgency: maintDraft.urgency, description: maintDraft.description, status: "Submitted", date: "Just now" }, ...prev]);
    setMaintDraft((d) => ({ ...d, description: "" }));
  }
  function advanceMaint(id) { setMaintReqs((prev) => prev.map((r) => r.id === id ? { ...r, status: r.status === "Submitted" ? "In progress" : "Resolved" } : r)); }
  function bookMover() {
    const mover = MOVERS.find((m) => m.id === moverDraft.moverId);
    const amount = moverDraft.moveType === "local" ? mover.local : mover.intercity;
    setPayment({ label: `Book ${mover.name} — ${moverDraft.moveType === "local" ? "local move" : "intercity move"}${moverDraft.date ? ` on ${moverDraft.date}` : ""}`, amount, successText: "Booking confirmed — the mover will call to finalize the pickup time.", onDone: () => setMoverBookings((prev) => [{ id: Date.now(), mover: mover.name, type: moverDraft.moveType, date: moverDraft.date || "Date TBD", amount }, ...prev]) });
  }
  function updateCart(id, delta) { setCart((prev) => { const next = Math.max(0, (prev[id] || 0) + delta); const copy = { ...prev }; if (next === 0) delete copy[id]; else copy[id] = next; return copy; }); }
  function checkoutFurniture() {
    if (cartCount === 0) return;
    setPayment({ label: "Monthly furniture rental", amount: cartTotal, recurring: true, successText: "Furniture rental confirmed — delivery within 3–5 days.", onDone: () => { setRentedItems((prev) => [...prev, ...Object.entries(cart).map(([id, qty]) => ({ id: `${id}-${Date.now()}`, name: FURNITURE.find((f) => f.id === id).name, qty, price: FURNITURE.find((f) => f.id === id).price }))]); setCart({}); } });
  }
  function buyInsurance(plan) { setPayment({ label: `${plan.name} belongings insurance`, amount: plan.price, recurring: true, successText: `You're covered up to ${plan.cover} under the ${plan.name} plan.`, onDone: () => setPurchasedPlan(plan) }); }
  async function submitPost() { if (!postDraft.text.trim()) return; try { const { post } = await api("/posts", { method: "POST", body: JSON.stringify(postDraft) }); setPosts((prev) => [post, ...prev]); setPostDraft({ text: "", tag: "General" }); } catch (e) { setAuthError(e.message); } }
  async function likePost(id) { try { const { post } = await api(`/posts/${id}/like`, { method: "POST" }); setPosts((prev) => prev.map((p) => p.id === id ? post : p)); } catch (e) { setAuthError(e.message); } }

  const tagColor = { Event: "#3B6FA6", Help: "var(--stamp)", Marketplace: "var(--sage)", General: "var(--ink)" };
  const studyLabel = persona === "student" ? "Study style" : "Work style";
  const studyOpts = persona === "student" ? ["Quiet focus", "Social study"] : ["WFH quiet", "Hybrid/social", "Office regular"];

  const field = "w-full text-sm px-3 py-2 bg-transparent";
  const fieldStyle = { border: "none", borderBottom: "1.5px solid color-mix(in srgb, var(--ink) 25%, transparent)", borderRadius: 0 };
  const livingTabs = persona === "student"
    ? [{ id: "maintenance", label: "Maintenance", icon: Wrench }, { id: "movers", label: "Movers", icon: Truck }, { id: "furniture", label: "Furniture", icon: Armchair }, { id: "insurance", label: "Insurance", icon: Umbrella }, { id: "community", label: "Community", icon: MessageSquare }]
    : [{ id: "maintenance", label: "Maintenance", icon: Wrench }, { id: "movers", label: "Relocation", icon: Truck }, { id: "coworking", label: "Co-working", icon: Laptop }, { id: "insurance", label: "Insurance", icon: Umbrella }];
  const subscriptionPlans = SUBSCRIPTION_PLANS[currentUser?.role === "lister" ? "lister" : "customer"] || SUBSCRIPTION_PLANS.customer;
  const NAV_META = {
    properties: { label: isOwner ? "Market" : "Rooms", icon: Home },
    roommates: { label: "Roommates", icon: Users },
    living: { label: "Living", icon: Wrench },
    list: { label: "My properties", icon: Plus },
    partners: { label: "Partners", icon: Building2 },
  };
  const navItems = navIdsForRole(currentUser?.role).map((id) => ({ id, ...NAV_META[id] }));

  if (!authChecked) {
    return (
      <div className="basera-app min-h-screen flex items-center justify-center" data-theme={darkMode ? "dark" : "light"} style={{ background: "var(--kraft)" }}>
        <BaseraThemeStyles />
        <Loader2 className="spin" size={28} style={{ color: "var(--marigold)" }} />
      </div>
    );
  }

  if (!currentUser) {
    return (
      <>
        <BaseraThemeStyles />
        <AuthPortal
          darkMode={darkMode} setDarkMode={setDarkMode}
          authMode={authMode} setAuthMode={setAuthMode}
          authRole={authRole} setAuthRole={setAuthRole}
          authPersona={authPersona} setAuthPersona={setAuthPersona}
          authStep={authStep}
          authForm={authForm} setAuthForm={setAuthForm}
          authError={authError} authBusy={authBusy}
          onSendOtp={handleSendOtp} onVerifyOtp={handleVerifyOtp} onChangeNumber={handleChangeNumber}
          resendCooldown={resendCooldown} devOtpHint={devOtpHint}
        />
      </>
    );
  }

  {/* Tenants browse for free; only owners need an active subscription to publish listings.
      Tenant subscription instead gates the property map + direct owner contact — see the
      Map/Contact section further down. */}
  if (!subscription?.active && currentUser.role === "lister") {
    return (
      <>
        <BaseraThemeStyles />
        <SubscriptionGate darkMode={darkMode} currentUser={currentUser} subscription={subscription} plans={subscriptionPlans} subBusy={subBusy} onActivate={activateSubscription} onLogout={logout} />
      </>
    );
  }

  return (
    <div className="basera-app" data-theme={darkMode ? "dark" : "light"} style={{ background: "var(--kraft)", color: "var(--ink)", fontFamily: "Inter, sans-serif", minHeight: "100%", transition: "background-color 0.25s, color 0.25s" }}>
      <BaseraThemeStyles />

      {/* Hero */}
      <div style={{ background: "var(--panel)" }} className="basera-hero px-6 pt-10 pb-8 sm:px-10 relative">
        <div className="absolute top-4 right-4 sm:right-10 flex items-center gap-2 z-10">
          <button type="button" onClick={() => setDarkMode((d) => !d)} className="flex items-center gap-1.5 text-[11px] font-mono uppercase px-2.5 py-1.5" style={{ border: "1px solid rgba(237,227,207,0.35)", color: "var(--panel-text)" }} title="Toggle dark mode">{darkMode ? <Sun size={14} style={{ color: "var(--marigold)" }} /> : <Moon size={14} style={{ color: "var(--marigold)" }} />}{darkMode ? "Light" : "Dark"}</button>
          <button type="button" onClick={refreshSubscriptionFromDb} className="hidden sm:inline text-[10px] font-mono uppercase px-2 py-1.5" style={{ border: "1px solid rgba(237,227,207,0.2)", color: "rgba(237,227,207,0.7)" }}>Sync plan</button>
          <button type="button" onClick={logout} className="flex items-center gap-1 text-[11px] font-mono uppercase px-2.5 py-1.5" style={{ color: "var(--marigold)" }}><LogOut size={13} /> {currentUser.name.split(" ")[0]}</button>
        </div>
        <div className="max-w-5xl mx-auto">
          <p className="font-mono text-[11px] uppercase tracking-[0.25em] mb-2" style={{ color: "var(--marigold)" }}><span aria-hidden="true" className="inline-block w-2.5 h-2.5 rounded-full animate-pulse mr-2 align-middle" style={{ background: "var(--marigold)" }} />Live in {Object.values(CITIES).filter((c) => c.live).length} cities &middot; Student &amp; professional housing</p>
          <h1 style={{ ...HEAD, fontSize: "clamp(48px,9vw,76px)", color: "var(--panel-text)", lineHeight: 0.9 }}>Basera</h1>
          <p className="mt-2 max-w-md text-[15px]" style={{ color: "rgba(237,227,207,0.75)" }}>
            {isOwner
              ? (persona === "student" ? "Reach verified students near campuses — no broker, no commission." : "Reach working professionals relocating for work — no broker, no commission.")
              : (persona === "student" ? "A room and a roommate, without the broker." : "Verified rooms and flatmates for professionals relocating for work.")}
          </p>
          {partner && <p className="mt-2 flex items-center gap-1.5 text-xs font-mono font-bold" style={{ color: "var(--marigold)" }}><Building2 size={13} /> {partner.name} {partner.kind === "company" ? "employee" : "student"} — {partner.perk.toLowerCase()}</p>}
          <p className="mt-2 text-[11px] font-mono" style={{ color: "rgba(237,227,207,0.55)" }}>{describeAccount(currentUser)} · {currentUser.role === "lister" ? `Plan: ${subscription?.plan || "Active"}` : subscription?.active ? `Map & direct contact: ${subscription.plan}` : "Map & direct contact: locked"}</p>

          <div className="flex flex-wrap items-center gap-3 mt-6">
            <div className="flex items-center gap-2 px-2 py-1" style={{ border: "1px solid rgba(237,227,207,0.3)" }}>
              <Globe size={14} style={{ color: "var(--marigold)" }} />
              <select value={selectedCity} onChange={(e) => setSelectedCity(e.target.value)} className="hero-select text-xs font-mono py-1" style={{ color: "var(--panel-text)", border: "none" }}>
                <optgroup label="Live now">{Object.entries(CITIES).filter(([, v]) => v.live).map(([name]) => <option key={name} value={name} style={{ color: "black" }}>{name}</option>)}</optgroup>
                <optgroup label="Coming soon">{Object.entries(CITIES).filter(([, v]) => !v.live).map(([name]) => <option key={name} value={name} disabled style={{ color: "black" }}>{name} — soon</option>)}</optgroup>
              </select>
            </div>
            <div className="flex items-center gap-2 text-[11px] font-mono font-bold uppercase tracking-wide" aria-label="Your account type">
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1.5" style={{ background: "color-mix(in srgb, var(--marigold) 18%, transparent)", color: "var(--marigold)", border: "1px solid color-mix(in srgb, var(--marigold) 45%, transparent)", borderRadius: 6 }}>
                {isOwner ? <Building2 size={13} /> : <Users size={13} />} {roleLabel(currentUser.role)}
              </span>
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1.5" style={{ color: "var(--panel-text)", border: "1px solid rgba(237,227,207,0.3)", borderRadius: 6 }}>
                {persona === "student" ? <BookOpen size={13} /> : <Briefcase size={13} />} {personaLabel(persona)}{isOwner ? " listings" : ""}
              </span>
            </div>
          </div>

          <nav aria-label="Main navigation" className="flex flex-wrap items-center gap-2 sm:gap-3 mt-6 pt-4 text-sm font-mono uppercase tracking-wide" style={{ borderTop: "1px solid rgba(237,227,207,0.15)" }}>
            {navItems.map(({ id, label, icon: Icon }) => (
              <button key={id} onClick={() => setTab(id)} aria-current={tab === id ? "page" : undefined} className={`category-pill flex items-center gap-1.5 ${tab === id ? "active-tab" : ""}`} style={{ color: tab === id ? "var(--panel-text)" : "color-mix(in srgb, var(--panel-text) 72%, transparent)" }}><Icon size={14} /> {label}</button>
            ))}
          </nav>
        </div>
        <div style={{ position: "absolute", left: 0, right: 0, bottom: -1, height: 12, backgroundColor: "var(--ink)", backgroundImage: `linear-gradient(135deg, var(--kraft) 25%, transparent 25%), linear-gradient(225deg, var(--kraft) 25%, transparent 25%)`, backgroundSize: "16px 12px", backgroundPosition: "-4px 0" }} />
      </div>

      {/* ---------------- Properties tab ---------------- */}
      {tab === "properties" && (
        <div className="max-w-5xl mx-auto px-6 sm:px-10 py-8">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-3 mb-8 p-5" style={{ background: "var(--paper)", border: "1px solid color-mix(in srgb, var(--ink) 14%, transparent)", borderRadius: 8, boxShadow: "0 4px 12px -4px rgba(0,0,0,0.08)" }}>
            <div className="w-full">
            <p className="flex items-center gap-1.5 text-[11px] font-mono uppercase tracking-wide mb-2" style={{ color: "color-mix(in srgb, var(--ink) 55%, transparent)" }}><SlidersHorizontal size={13} /> Filters</p>
            <div className="search-box flex items-center gap-2 px-3 py-2 mb-3" style={{ background: "color-mix(in srgb, var(--ink) 5%, transparent)", border: "1px solid color-mix(in srgb, var(--ink) 14%, transparent)", borderRadius: 6 }}>
              <Search size={16} style={{ color: "var(--marigold)" }} />
              <input type="search" aria-label="Search by locality, landmark or listing name" placeholder="Search locality, landmark or listing name..." value={filters.query} onChange={(e) => setFilters((f) => ({ ...f, query: e.target.value }))} className="flex-1 bg-transparent text-sm outline-none font-mono" style={{ color: "var(--ink)", border: "none" }} />
              {filters.query && <button type="button" aria-label="Clear search" onClick={() => setFilters((f) => ({ ...f, query: "" }))} className="icon-hover-btn p-0.5" style={{ color: "color-mix(in srgb, var(--ink) 55%, transparent)" }}><X size={14} /></button>}
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <select value={filters.area} onChange={(e) => setFilters((f) => ({ ...f, area: e.target.value }))} className={field} style={{ ...fieldStyle, width: "100%" }}>
              <option value="All">All areas</option>{cityAreas.map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
            <select value={filters.type} onChange={(e) => setFilters((f) => ({ ...f, type: e.target.value }))} className={field} style={{ ...fieldStyle, width: "100%" }}>{roomTypes.map((t) => <option key={t} value={t}>{t === "All" ? "All room types" : t}</option>)}</select>
            <select value={filters.gender} onChange={(e) => setFilters((f) => ({ ...f, gender: e.target.value }))} className={field} style={{ ...fieldStyle, width: "100%" }}><option value="Any">Any gender</option><option value="Female">Female</option><option value="Male">Male</option></select>
            <select aria-label="AC or Non-AC" value={filters.ac} onChange={(e) => setFilters((f) => ({ ...f, ac: e.target.value }))} className={field} style={{ ...fieldStyle, width: "100%" }}>{AC_FILTER_OPTIONS.map((o) => <option key={o} value={o}>{o === "Any" ? "All" : o === "Non-AC" ? "Non AC" : o}</option>)}</select>
            </div>
            </div>
            <label className="flex items-center gap-2 text-sm flex-1 min-w-[180px] ">Up to <span className="font-mono font-bold">₹{filters.maxRent.toLocaleString("en-IN")}</span><input type="range" min="5000" max="22000" step="500" value={filters.maxRent} onChange={(e) => setFilters((f) => ({ ...f, maxRent: +e.target.value }))} className="flex-1" /></label>
            <label className="flex items-center gap-1.5 text-sm "><input type="checkbox" checked={filters.verifiedOnly} onChange={(e) => setFilters((f) => ({ ...f, verifiedOnly: e.target.checked }))} /> Verified only</label>
            {!isOwner && <label className="flex items-center gap-1.5 text-sm "><input type="checkbox" checked={filters.savedOnly} onChange={(e) => setFilters((f) => ({ ...f, savedOnly: e.target.checked }))} /> <Heart size={13} style={{ color: "var(--marigold)" }} /> Saved ({favorites.length})</label>}
            {persona === "professional" && <label className="flex items-center gap-1.5 text-sm "><input type="checkbox" checked={filters.wfhOnly} onChange={(e) => setFilters((f) => ({ ...f, wfhOnly: e.target.checked }))} /> <Laptop size={13} /> WFH-friendly</label>}
            {!isOwner && (
              <div className="flex flex-wrap items-center gap-2  w-full sm:w-auto">
                <button type="button" onClick={requestNearby} className="flex items-center gap-1.5 text-xs font-mono font-bold uppercase px-3 py-1.5" style={{ background: nearbyActive ? "var(--marigold)" : "transparent", color: nearbyActive ? "var(--ink)" : "var(--ink)", border: "1px dashed color-mix(in srgb, var(--ink) 35%, transparent)" }}><Navigation size={13} /> {nearbyActive ? "Sorted by distance" : "Nearby PG & rooms"}</button>
                {nearbyActive && <button type="button" onClick={() => { setNearbyActive(false); setUserGeo(null); }} className="text-[11px] font-mono underline" style={{ color: "color-mix(in srgb, var(--ink) 50%, transparent)" }}>Clear</button>}
                {geoError && <span className="text-xs" style={{ color: "var(--stamp)" }}>{geoError}</span>}
              </div>
            )}
          </div>

          {isOwner ? (
            <Notice i={99} pinColor="var(--sage)" className="mb-8 p-4" style={{ transform: "rotate(-0.3deg)" }}>
              <p className="flex items-center gap-2 text-sm font-bold" style={{ color: "var(--ink)" }}><Building2 size={15} style={{ color: "var(--sage)" }} /> Market view &middot; {persona === "student" ? "student" : "professional"} listings in {selectedCity}</p>
              <p className="text-xs mt-1" style={{ color: "color-mix(in srgb, var(--ink) 60%, transparent)" }}>See what other owners are charging for {persona === "student" ? "students" : "working professionals"} before you price your own place. Manage your listings under "My properties".</p>
            </Notice>
          ) : (
          <Notice i={99} pinColor="var(--marigold)" className="mb-8 p-4" style={{ transform: "rotate(-0.3deg)" }}>
            <div className="flex items-center justify-between flex-wrap gap-2">
              <p className="flex items-center gap-2 text-sm font-bold" style={{ color: "var(--ink)" }}><Wand2 size={15} style={{ color: "var(--marigold)" }} /> Personalized picks</p>
              <button onClick={getAIRecommendation} disabled={aiRec.loading} className="flex items-center gap-1.5 text-xs font-mono font-bold uppercase px-3 py-1.5 disabled:opacity-60" style={{ background: "var(--marigold)", color: "var(--ink)" }}>{aiRec.loading ? <Loader2 size={13} className="spin" /> : <Sparkles size={13} />} {aiRec.text ? "Refresh" : "Get AI picks"}</button>
            </div>
            {aiRec.text && <p className="text-sm mt-3" style={{ color: "color-mix(in srgb, var(--ink) 80%, transparent)" }}>{aiRec.text}</p>}
            {aiRec.error && <p className="text-sm mt-3" style={{ color: "var(--stamp)" }}>Couldn't reach the AI just now — try again in a moment.</p>}
            {!aiRec.text && !aiRec.loading && !aiRec.error && <p className="text-xs mt-1" style={{ color: "color-mix(in srgb, var(--ink) 50%, transparent)" }}>Uses your budget of ₹{profile.budget.toLocaleString("en-IN")} and preference for {profile.area}, set on the roommate tab.</p>}
          </Notice>
          )}

          <div className="flex items-end justify-between flex-wrap gap-2 mb-5">
            <h2 style={{ ...HEAD, fontSize: 30, color: "var(--ink)", lineHeight: 1 }}>Curated listings</h2>
            <span className="text-xs font-mono" style={{ color: "color-mix(in srgb, var(--ink) 60%, transparent)" }}>{filteredProps.length} {filteredProps.length === 1 ? "space" : "spaces"} available in {selectedCity}</span>
          </div>

          {filteredProps.length === 0 ? (
            <div className="text-center py-16" style={{ border: "1px dashed color-mix(in srgb, var(--ink) 25%, transparent)" }}>
              <Search className="mx-auto mb-3" size={28} style={{ color: "var(--ink)", opacity: 0.4 }} />
              <p style={{ ...HEAD, fontSize: 22, color: "var(--ink)" }}>No rooms match yet</p>
              <p className="text-sm mt-1" style={{ color: "color-mix(in srgb, var(--ink) 60%, transparent)" }}>Try widening your rent range or clearing a filter.</p>
            </div>
          ) : (
            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-6 pt-2">
              {filteredProps.map((p, i) => {
                const rating = avgRating(p.reviews);
                return (
                  <Notice key={p.id} i={i} onClick={() => setSelected(p)} aria-label={`${p.title}, ₹${p.rent} per month. Open details`} className="text-left flex flex-col">
                    {p.premium && <Stamp color="var(--marigold)" rotate={7} style={{ position: "absolute", top: -10, right: -6, background: "var(--paper)" }}><Award size={10} /> Featured</Stamp>}
                    {signedIds[p.id] && <span className="absolute top-2 right-2 z-10"><FileText size={14} style={{ color: "var(--sage)" }} /></span>}
                    <div className="relative h-44 flex items-center justify-center overflow-hidden" style={{ background: "var(--panel)", borderRadius: "5px 5px 0 0" }}>
                      <CardImage src={coverFor(p)} alt={`${p.title} — cover photo`} className="card-img-zoom" iconSize={26} />
                      <div aria-hidden="true" className="absolute inset-0 pointer-events-none" style={{ background: "linear-gradient(to top, rgba(0,0,0,0.55), transparent 55%)", opacity: 0.55 }} />
                      {!isOwner && <button type="button" onClick={(e) => { e.stopPropagation(); toggleFavorite(p.id); }} aria-pressed={favorites.includes(p.id)} aria-label={favorites.includes(p.id) ? `Remove ${p.title} from saved` : `Save ${p.title}`} className="icon-hover-btn absolute top-3 right-3 p-2 z-20" style={{ background: "rgba(0,0,0,0.45)", color: "#fff", backdropFilter: "blur(6px)" }}>
                        <Heart size={15} fill={favorites.includes(p.id) ? "var(--marigold)" : "none"} style={{ color: favorites.includes(p.id) ? "var(--marigold)" : "currentColor" }} />
                      </button>}
                      {(normalizeAc(p.ac) || (p.bhk && p.bhk !== "Not specified")) && <span className="absolute bottom-3 left-3 px-2 py-0.5 text-[11px] font-mono font-medium tracking-wide" style={{ background: "rgba(0,0,0,0.6)", color: "#fff", borderRadius: 4 }}>{[normalizeAc(p.ac), p.bhk && p.bhk !== "Not specified" ? p.bhk : null].filter(Boolean).join(" · ")}</span>}
                    </div>
                    <div className="p-4">
                      <h3 className="card-title font-bold text-[15px] leading-snug" style={{ color: "var(--ink)" }}>{p.title}</h3>
                      <div className="mt-1.5"><StatusStamp status={p.status} /></div>
                      <p className="flex items-center gap-1 text-xs mt-2" style={{ color: "color-mix(in srgb, var(--ink) 60%, transparent)" }}><MapPin size={12} /> {p.area}, {p.city} &middot; {Number(p.displayDist ?? p.dist).toFixed(1)} km {nearbyActive && userGeo ? "from you" : distLabel}</p>
                      {normalizeAc(p.ac) && <span className="text-[10px] font-mono font-bold uppercase mr-2 px-1.5 py-0.5" style={{ background: "var(--kraft)", color: "var(--ink)" }}>{normalizeAc(p.ac)}</span>}
                      {(p.bhk && p.bhk !== "Not specified") && <span className="text-[11px] font-mono font-bold mr-2" style={{ color: "var(--sage)" }}>{p.bhk}</span>}
                      {formatAreaSqft(p.dimensionValue) && <span className="text-[11px] font-mono" style={{ color: "color-mix(in srgb, var(--ink) 55%, transparent)" }}>{formatAreaSqft(p.dimensionValue)}</span>}
                      {(p.tenantFor && p.tenantFor !== "any") && <span className="text-[10px] font-mono uppercase mt-1 inline-block" style={{ color: "color-mix(in srgb, var(--ink) 45%, transparent)" }}>For {p.tenantFor}</span>}
                      <div className="flex items-center justify-between mt-3">
                        <span className="font-mono text-lg font-bold" style={{ color: "var(--ink)" }}>₹{p.rent.toLocaleString("en-IN")}<span className="text-xs font-normal" style={{ color: "color-mix(in srgb, var(--ink) 50%, transparent)" }}>/mo</span></span>
                        {rating ? <span className="flex items-center gap-1 text-xs"><Star size={12} fill="var(--marigold)" style={{ color: "var(--marigold)" }} /> {rating} <span style={{ color: "color-mix(in srgb, var(--ink) 40%, transparent)" }}>({p.reviews.length})</span></span> : <span className="text-xs" style={{ color: "color-mix(in srgb, var(--ink) 40%, transparent)" }}>No reviews</span>}
                      </div>
                      <div className="flex flex-wrap gap-1.5 mt-3">
                        <span className="text-[11px] px-2 py-0.5" style={{ background: "var(--kraft)" }}>{p.type}</span>
                        <span className="text-[11px] px-2 py-0.5" style={{ background: "var(--kraft)" }}>{p.gender}</span>
                        {p.food && <span className="text-[11px] px-2 py-0.5 flex items-center gap-1" style={{ background: "var(--kraft)" }}><UtensilsCrossed size={10} /> Food</span>}
                        {p.wifi && <span className="text-[11px] px-2 py-0.5 flex items-center gap-1" style={{ background: "var(--kraft)" }}><Wifi size={10} /> Wifi</span>}
                      </div>
                      <div className="flex items-center justify-between mt-4 pt-3" style={{ borderTop: "1px solid color-mix(in srgb, var(--ink) 10%, transparent)" }}>
                        <span className="text-[11px] font-mono" style={{ color: "color-mix(in srgb, var(--ink) 50%, transparent)" }}>{p.reviews.length ? `${p.reviews.length} review${p.reviews.length === 1 ? "" : "s"}` : "No reviews yet"}</span>
                        <span className="inline-flex items-center gap-1 text-xs font-mono font-bold uppercase tracking-wider px-3 py-1.5" style={{ background: "var(--marigold)", color: "#1E2A38", borderRadius: 4 }}>View details <ArrowRight size={12} /></span>
                      </div>
                    </div>
                  </Notice>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ---------------- Roommates tab ---------------- */}
      {tab === "roommates" && !showMatches && (
        <div className="max-w-xl mx-auto px-6 sm:px-10 py-8">
          <SectionTitle sub={`We'll match you against ${persona === "student" ? "students" : "professionals"} looking for a flatmate in ${selectedCity}.`}>Tell us how you live</SectionTitle>
          <div className="space-y-4 p-5" style={{ background: "var(--paper)", border: "1px solid color-mix(in srgb, var(--ink) 12%, transparent)" }}>
            <div>
              <label className="text-xs font-mono uppercase tracking-wide" style={{ color: "color-mix(in srgb, var(--ink) 50%, transparent)" }}>Preferred area</label>
              <select value={profile.area} onChange={(e) => setProfile((p) => ({ ...p, area: e.target.value }))} className={field} style={fieldStyle}>{cityAreas.map((a) => <option key={a} value={a}>{a}</option>)}</select>
            </div>
            <div>
              <label className="text-xs font-mono uppercase tracking-wide" style={{ color: "color-mix(in srgb, var(--ink) 50%, transparent)" }}>Monthly budget: <span className="font-mono font-bold">₹{profile.budget.toLocaleString("en-IN")}</span></label>
              <input type="range" min="5000" max="22000" step="500" value={profile.budget} onChange={(e) => setProfile((p) => ({ ...p, budget: +e.target.value }))} className="w-full mt-2" />
            </div>
            <div className="grid grid-cols-2 gap-4">
              {[
                { key: "gender", label: "Gender", opts: ["Female", "Male", "Any"] },
                { key: "food", label: "Food", opts: ["Veg", "Non-veg", "Either"] },
                { key: "sleep", label: "Sleep schedule", opts: ["Early bird", "Night owl", "Flexible"] },
                { key: "clean", label: "Tidiness", opts: ["Very tidy", "Moderately tidy", "Relaxed"] },
                { key: "smoking", label: "Smoking", opts: ["No", "Occasional"] },
                { key: "study", label: studyLabel, opts: studyOpts },
              ].map(({ key, label, opts }) => (
                <div key={key}>
                  <label className="text-xs font-mono uppercase tracking-wide" style={{ color: "color-mix(in srgb, var(--ink) 50%, transparent)" }}>{label}</label>
                  <select value={profile[key]} onChange={(e) => setProfile((p) => ({ ...p, [key]: e.target.value }))} className={field} style={fieldStyle}>{opts.map((o) => <option key={o} value={o}>{o}</option>)}</select>
                </div>
              ))}
            </div>
            <button onClick={() => setShowMatches(true)} className="w-full mt-2 flex items-center justify-center gap-2 py-2.5 text-sm font-bold uppercase tracking-wide" style={{ background: "var(--marigold)", color: "var(--ink)" }}><Sparkles size={15} /> Find my matches <ArrowRight size={15} /></button>
          </div>
        </div>
      )}

      {tab === "roommates" && showMatches && (
        <div className="max-w-2xl mx-auto px-6 sm:px-10 py-8">
          <button onClick={() => setShowMatches(false)} className="flex items-center gap-1 text-sm mb-4 font-mono" style={{ color: "var(--ink)" }}><ChevronLeft size={15} /> Edit preferences</button>
          <SectionTitle sub={`Ranked by budget, area, food, sleep schedule, tidiness, smoking and ${persona === "student" ? "study" : "work"} style, in ${selectedCity}.`}>Your best matches</SectionTitle>
          {matches.length === 0 ? (
            <div className="text-center py-14" style={{ border: "1px dashed color-mix(in srgb, var(--ink) 25%, transparent)" }}>
              <Users className="mx-auto mb-3" size={26} style={{ color: "var(--ink)", opacity: 0.4 }} />
              <p style={{ ...HEAD, fontSize: 22 }}>No profiles in {selectedCity} yet</p>
              <p className="text-sm mt-1 max-w-xs mx-auto" style={{ color: "color-mix(in srgb, var(--ink) 60%, transparent)" }}>Basera just launched here — the roommate pool is still growing. Try Delhi NCR, our original pilot city, in the meantime.</p>
            </div>
          ) : (
            <div className="space-y-5">
              {matches.map((c, i) => {
                const insight = aiInsights[c.id];
                return (
                  <Notice key={c.id} i={i} className="p-4 flex items-start gap-4">
                    <div className="w-11 h-11 rounded-full flex items-center justify-center flex-shrink-0" style={{ ...HEAD, background: "var(--panel)", color: "var(--marigold)", fontSize: 18 }}>{c.name[0]}</div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-2 flex-wrap">
                        <h3 className="font-bold text-[15px]" style={{ color: "var(--ink)" }}>{c.name} <span className="font-normal text-xs" style={{ color: "color-mix(in srgb, var(--ink) 50%, transparent)" }}>&middot; {c.area}</span></h3>
                        <Gauge score={c.score} />
                      </div>
                      <p className="text-sm mt-1" style={{ color: "color-mix(in srgb, var(--ink) 70%, transparent)" }}>{c.bio}</p>
                      <div className="flex flex-wrap gap-1.5 mt-2">
                        <span className="text-[11px] px-2 py-0.5 font-mono" style={{ background: "var(--kraft)" }}>₹{c.budget.toLocaleString("en-IN")}/mo</span>
                        <span className="text-[11px] px-2 py-0.5 flex items-center gap-1" style={{ background: "var(--kraft)" }}>{c.sleep === "Night owl" ? <Moon size={10} /> : <Sunrise size={10} />} {c.sleep}</span>
                        <span className="text-[11px] px-2 py-0.5 flex items-center gap-1" style={{ background: "var(--kraft)" }}><BookOpen size={10} /> {c.study}</span>
                        {c.smoking !== "No" && <span className="text-[11px] px-2 py-0.5 flex items-center gap-1" style={{ background: "var(--kraft)" }}><Cigarette size={10} /> {c.smoking}</span>}
                      </div>
                      {insight?.text && <p className="flex items-start gap-1.5 text-xs mt-3 p-2" style={{ background: "color-mix(in srgb, var(--marigold) 12%, transparent)", color: "var(--ink)" }}><Wand2 size={12} className="mt-0.5 flex-shrink-0" style={{ color: "var(--marigold)" }} /> {insight.text}</p>}
                      {insight?.error && <p className="text-xs mt-3" style={{ color: "var(--stamp)" }}>Couldn't reach the AI just now — try again.</p>}
                      {!insight?.text && <button onClick={() => getMatchInsight(c)} disabled={insight?.loading} className="flex items-center gap-1.5 text-xs font-mono font-bold uppercase mt-3 px-2.5 py-1 disabled:opacity-60" style={{ background: "color-mix(in srgb, var(--marigold) 15%, transparent)", color: "var(--marigold)" }}>{insight?.loading ? <Loader2 size={12} className="spin" /> : <Wand2 size={12} />} Why we matched</button>}
                    </div>
                  </Notice>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ---------------- Student Living tab ---------------- */}
      {tab === "living" && (
        <div className="max-w-3xl mx-auto px-6 sm:px-10 py-8">
          <SectionTitle sub="Everything after move-in: repairs, moving help, furniture, insurance, and your local community board.">{persona === "student" ? "Student living" : "Living, sorted"}</SectionTitle>
          <p className="text-xs mb-5 font-mono" style={{ color: "color-mix(in srgb, var(--ink) 45%, transparent)" }}>Piloting in Delhi NCR first — expanding with the city rollout.</p>

          <div className="flex flex-wrap gap-x-5 gap-y-1 mb-6 text-xs font-mono uppercase tracking-wide" style={{ borderBottom: "1px dashed color-mix(in srgb, var(--ink) 25%, transparent)" }}>
            {livingTabs.map(({ id, label, icon: Icon }) => (
              <button key={id} onClick={() => setLivingSub(id)} className="flex items-center gap-1.5 pb-2" style={{ color: livingSub === id ? "var(--ink)" : "color-mix(in srgb, var(--ink) 45%, transparent)", borderBottom: livingSub === id ? "2px solid var(--marigold)" : "2px solid transparent" }}><Icon size={13} /> {label}</button>
            ))}
          </div>

          {livingSub === "coworking" && persona === "professional" && (
            <div className="space-y-4">
              <p className="text-sm" style={{ color: "color-mix(in srgb, var(--ink) 70%, transparent)" }}>Professionals get desk-day passes and meeting-room credits near your listing area — not bundled for students.</p>
              {[{ name: "Basera Desk — Koramangala", perk: "4 hot-desk days / month", price: 0 }, { name: "WeWork day pass", perk: "1 day pass with Premium insurance", price: 499 }].map((c, i) => (
                <Notice key={c.name} i={i} className="p-4 flex items-center justify-between gap-3 flex-wrap">
                  <div><p className="font-bold text-sm flex items-center gap-2"><Laptop size={14} /> {c.name}</p><p className="text-xs mt-1" style={{ color: "color-mix(in srgb, var(--ink) 60%, transparent)" }}>{c.perk}</p></div>
                  <span className="font-mono text-sm font-bold">{c.price === 0 ? "Included" : `₹${c.price}`}</span>
                </Notice>
              ))}
            </div>
          )}

          {livingSub === "maintenance" && (
            <div>
              <div className="p-5 space-y-3" style={{ background: "var(--paper)", border: "1px solid color-mix(in srgb, var(--ink) 12%, transparent)" }}>
                <div className="grid grid-cols-2 gap-3">
                  <select value={maintDraft.propertyId} onChange={(e) => setMaintDraft((d) => ({ ...d, propertyId: +e.target.value }))} className={field} style={fieldStyle}>{properties.map((p) => <option key={p.id} value={p.id}>{p.title} ({p.city})</option>)}</select>
                  <select value={maintDraft.issueType} onChange={(e) => setMaintDraft((d) => ({ ...d, issueType: e.target.value }))} className={field} style={fieldStyle}>{["Plumbing", "Electrical", "Wifi", "Cleaning", "Furniture damage", "Other"].map((t) => <option key={t}>{t}</option>)}</select>
                </div>
                <div className="flex gap-2">{["Low", "Medium", "High"].map((u) => <button key={u} onClick={() => setMaintDraft((d) => ({ ...d, urgency: u }))} className="text-xs font-mono uppercase px-3 py-1.5" style={{ background: maintDraft.urgency === u ? "var(--ink)" : "var(--kraft)", color: maintDraft.urgency === u ? "var(--kraft)" : "var(--ink)" }}>{u}</button>)}</div>
                <textarea placeholder="Describe the issue..." value={maintDraft.description} onChange={(e) => setMaintDraft((d) => ({ ...d, description: e.target.value }))} className="w-full text-sm px-3 py-2 h-20" style={{ border: "1px dashed color-mix(in srgb, var(--ink) 30%, transparent)", background: "var(--kraft)" }} />
                <button onClick={submitMaintenance} disabled={!maintDraft.description} className="w-full py-2.5 text-sm font-bold uppercase tracking-wide disabled:opacity-40" style={{ background: "var(--marigold)", color: "var(--ink)" }}>Submit request</button>
              </div>
              {maintReqs.length > 0 && (
                <div className="mt-6 space-y-4">
                  <h3 style={{ ...HEAD, fontSize: 20 }}>My requests</h3>
                  {maintReqs.map((r, i) => (
                    <Notice key={r.id} i={i} className="p-4">
                      <div className="flex items-center justify-between flex-wrap gap-2"><p className="font-bold text-sm">{r.issueType} &middot; {r.propertyTitle}</p><MaintStatusBadge status={r.status} /></div>
                      <p className="text-sm mt-1" style={{ color: "color-mix(in srgb, var(--ink) 70%, transparent)" }}>{r.description}</p>
                      <div className="flex items-center justify-between mt-2"><span className="text-[11px] font-mono" style={{ color: "color-mix(in srgb, var(--ink) 45%, transparent)" }}>{r.urgency} urgency &middot; {r.date}</span>{r.status !== "Resolved" && <button onClick={() => advanceMaint(r.id)} className="text-[11px] font-mono font-bold uppercase px-2.5 py-1" style={{ background: "rgba(59,111,166,0.12)", color: "#3B6FA6" }}>Advance status</button>}</div>
                    </Notice>
                  ))}
                </div>
              )}
            </div>
          )}

          {livingSub === "movers" && (
            <div>
              <div className="grid sm:grid-cols-3 gap-5 mb-6 pt-2">
                {MOVERS.map((m, i) => (
                  <Notice as="button" key={m.id} i={i} onClick={() => setMoverDraft((d) => ({ ...d, moverId: m.id }))} className="text-left p-4 cursor-pointer" style={{ transform: `rotate(${tilt(i)}) ${moverDraft.moverId === m.id ? "scale(1.02)" : ""}`, outline: moverDraft.moverId === m.id ? "2px solid var(--marigold)" : "none" }}>
                    <p className="font-bold text-sm flex items-center gap-1"><Truck size={14} style={{ color: "var(--ink)" }} /> {m.name}</p>
                    <p className="text-xs mt-1" style={{ color: "color-mix(in srgb, var(--ink) 60%, transparent)" }}>{m.tagline}</p>
                    <p className="flex items-center gap-1 text-xs mt-2"><Star size={11} fill="var(--marigold)" style={{ color: "var(--marigold)" }} /> {m.rating}</p>
                    <p className="font-mono text-sm font-bold mt-2" style={{ color: "var(--ink)" }}>₹{m.local.toLocaleString("en-IN")} <span className="text-[10px] font-normal">local</span></p>
                  </Notice>
                ))}
              </div>
              <div className="p-5" style={{ background: "var(--paper)", border: "1px solid color-mix(in srgb, var(--ink) 12%, transparent)" }}>
                <div className="flex gap-2 mb-3">
                  <button onClick={() => setMoverDraft((d) => ({ ...d, moveType: "local" }))} className="flex-1 text-sm py-2 font-mono uppercase" style={{ background: moverDraft.moveType === "local" ? "var(--ink)" : "var(--kraft)", color: moverDraft.moveType === "local" ? "var(--kraft)" : "var(--ink)" }}>Local</button>
                  <button onClick={() => setMoverDraft((d) => ({ ...d, moveType: "intercity" }))} className="flex-1 text-sm py-2 font-mono uppercase" style={{ background: moverDraft.moveType === "intercity" ? "var(--ink)" : "var(--kraft)", color: moverDraft.moveType === "intercity" ? "var(--kraft)" : "var(--ink)" }}>Intercity</button>
                </div>
                <input type="date" value={moverDraft.date} onChange={(e) => setMoverDraft((d) => ({ ...d, date: e.target.value }))} className="w-full text-sm px-3 py-2 mb-3" style={{ border: "1px dashed color-mix(in srgb, var(--ink) 30%, transparent)", background: "var(--kraft)" }} />
                <button onClick={bookMover} className="w-full py-2.5 text-sm font-bold uppercase tracking-wide" style={{ background: "var(--marigold)", color: "var(--ink)" }}>Book — ₹{(moverDraft.moveType === "local" ? MOVERS.find((m) => m.id === moverDraft.moverId).local : MOVERS.find((m) => m.id === moverDraft.moverId).intercity).toLocaleString("en-IN")}</button>
              </div>
              {moverBookings.length > 0 && (
                <div className="mt-6 space-y-2">
                  <h3 style={{ ...HEAD, fontSize: 20 }} className="mb-2">My bookings</h3>
                  {moverBookings.map((b) => <div key={b.id} className="p-3 flex items-center justify-between text-sm" style={{ background: "var(--paper)", border: "1px solid color-mix(in srgb, var(--ink) 12%, transparent)" }}><span>{b.mover} &middot; {b.type === "local" ? "Local" : "Intercity"} &middot; {b.date}</span><span className="font-mono font-bold">₹{b.amount.toLocaleString("en-IN")}</span></div>)}
                </div>
              )}
            </div>
          )}

          {livingSub === "furniture" && (
            <div>
              <div className="grid sm:grid-cols-2 gap-3">
                {FURNITURE.map((f) => (
                  <div key={f.id} className="p-4 flex items-center justify-between" style={{ background: "var(--paper)", border: "1px solid color-mix(in srgb, var(--ink) 12%, transparent)" }}>
                    <div><p className="font-bold text-sm">{f.name}</p><p className="font-mono text-xs mt-0.5" style={{ color: "var(--ink)" }}>₹{f.price}/mo</p></div>
                    <div className="flex items-center gap-2">
                      <button onClick={() => updateCart(f.id, -1)} className="w-7 h-7 flex items-center justify-center" style={{ background: "var(--kraft)" }}><Minus size={13} /></button>
                      <span className="font-mono text-sm w-4 text-center">{cart[f.id] || 0}</span>
                      <button onClick={() => updateCart(f.id, 1)} className="w-7 h-7 flex items-center justify-center" style={{ background: "var(--marigold)", color: "var(--ink)" }}><Plus size={13} /></button>
                    </div>
                  </div>
                ))}
              </div>
              {cartCount > 0 && <div className="mt-5 p-4 flex items-center justify-between flex-wrap gap-3" style={{ background: "color-mix(in srgb, var(--marigold) 12%, transparent)", border: "1px dashed var(--marigold)" }}><p className="text-sm font-medium">{cartCount} item{cartCount > 1 ? "s" : ""} &middot; <span className="font-mono font-bold">₹{cartTotal.toLocaleString("en-IN")}/mo</span></p><button onClick={checkoutFurniture} className="px-4 py-2 text-sm font-bold uppercase" style={{ background: "var(--marigold)", color: "var(--ink)" }}>Rent now</button></div>}
              {rentedItems.length > 0 && (
                <div className="mt-6">
                  <h3 style={{ ...HEAD, fontSize: 20 }} className="mb-2">Currently renting</h3>
                  <div className="space-y-2">{rentedItems.map((r) => <div key={r.id} className="p-3 flex items-center justify-between text-sm" style={{ background: "var(--paper)", border: "1px solid color-mix(in srgb, var(--ink) 12%, transparent)" }}><span>{r.name} &times;{r.qty}</span><span className="font-mono font-bold">₹{(r.price * r.qty).toLocaleString("en-IN")}/mo</span></div>)}</div>
                </div>
              )}
            </div>
          )}

          {livingSub === "insurance" && (
            <div>
              {purchasedPlan && <div className="p-3 mb-4 flex items-center gap-2 text-sm font-bold" style={{ background: "color-mix(in srgb, var(--sage) 12%, transparent)", color: "var(--sage)" }}><CheckCircle2 size={15} /> Active plan: {purchasedPlan.name} — covered up to {purchasedPlan.cover}</div>}
              <div className="grid sm:grid-cols-3 gap-5 pt-2">
                {INSURANCE_PLANS.map((plan, i) => (
                  <Notice key={plan.id} i={i} className="p-4 flex flex-col" pinColor="var(--sage)" style={{ transform: `rotate(${tilt(i)})`, outline: purchasedPlan?.id === plan.id ? "2px solid var(--sage)" : "none" }}>
                    <p style={{ ...HEAD, fontSize: 20 }}>{plan.name}</p>
                    <p className="font-mono text-xl font-bold mt-1" style={{ color: "var(--ink)" }}>₹{plan.price}<span className="text-xs font-normal">/mo</span></p>
                    <p className="text-xs mt-1" style={{ color: "color-mix(in srgb, var(--ink) 60%, transparent)" }}>Covers up to {plan.cover}</p>
                    <ul className="text-xs mt-3 space-y-1.5 flex-1">{plan.points.map((pt) => <li key={pt} className="flex items-start gap-1.5"><CheckCircle2 size={12} className="mt-0.5 flex-shrink-0" style={{ color: "var(--sage)" }} /> {pt}</li>)}</ul>
                    <button onClick={() => buyInsurance(plan)} disabled={purchasedPlan?.id === plan.id} className="w-full mt-4 py-2 text-xs font-bold uppercase disabled:opacity-50" style={{ background: "var(--marigold)", color: "var(--ink)" }}>{purchasedPlan?.id === plan.id ? "Active" : "Choose plan"}</button>
                  </Notice>
                ))}
              </div>
            </div>
          )}

          {livingSub === "community" && (
            <div>
              <div className="p-4 mb-6" style={{ background: "var(--paper)", border: "1px solid color-mix(in srgb, var(--ink) 12%, transparent)" }}>
                <textarea placeholder="Share something with the community — an event, a question, an item to sell..." value={postDraft.text} onChange={(e) => setPostDraft((d) => ({ ...d, text: e.target.value }))} className="w-full text-sm px-3 py-2 h-16" style={{ border: "1px dashed color-mix(in srgb, var(--ink) 30%, transparent)", background: "var(--kraft)" }} />
                <div className="flex items-center justify-between mt-2">
                  <div className="flex gap-1.5">{["General", "Event", "Help", "Marketplace"].map((t) => <button key={t} onClick={() => setPostDraft((d) => ({ ...d, tag: t }))} className="text-[11px] font-mono font-bold uppercase px-2.5 py-1" style={{ background: postDraft.tag === t ? tagColor[t] : "var(--kraft)", color: postDraft.tag === t ? "white" : "var(--ink)" }}>{t}</button>)}</div>
                  <button onClick={submitPost} disabled={!postDraft.text.trim()} className="flex items-center gap-1.5 text-xs font-bold uppercase px-3 py-1.5 disabled:opacity-40" style={{ background: "var(--marigold)", color: "var(--ink)" }}><Send size={12} /> Post</button>
                </div>
              </div>
              <div className="space-y-4">
                {posts.map((p, i) => (
                  <Notice key={p.id} i={i} className="p-4">
                    <div className="flex items-center gap-2 flex-wrap"><span className="font-bold text-sm">{p.author}</span><span className="text-[10px] font-mono font-bold uppercase px-2 py-0.5" style={{ background: tagColor[p.tag], color: "white" }}>{p.tag}</span><span className="text-[11px] font-mono" style={{ color: "color-mix(in srgb, var(--ink) 40%, transparent)" }}>{p.date}</span></div>
                    <p className="text-sm mt-1.5" style={{ color: "color-mix(in srgb, var(--ink) 80%, transparent)" }}>{p.text}</p>
                    <button onClick={() => likePost(p.id)} className="flex items-center gap-1 text-xs mt-2" style={{ color: "color-mix(in srgb, var(--ink) 50%, transparent)" }}><Heart size={13} /> {p.likes}</button>
                  </Notice>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ---------------- List a property tab ---------------- */}
      {tab === "list" && currentUser.role === "lister" && (
        <div className="max-w-xl mx-auto px-6 sm:px-10 py-8">
          {listStep === "form" && (
            <>
              <SectionTitle sub={`Listing in ${selectedCity}. Free to list — verified, featured listings get seen first.`}>List your property</SectionTitle>
              <div className="space-y-3 p-5" style={{ background: "var(--paper)", border: "1px solid color-mix(in srgb, var(--ink) 12%, transparent)" }}>
                <input placeholder="Listing title (e.g. Cozy 2-sharing near campus)" value={newListing.title} onChange={(e) => setNewListing((l) => ({ ...l, title: e.target.value }))} className={field} style={fieldStyle} />
                <div>
                  <p className="text-xs font-mono uppercase tracking-wide mb-2" style={{ color: "color-mix(in srgb, var(--ink) 50%, transparent)" }}>Preferred tenants</p>
                  <div className="flex flex-wrap gap-3 text-sm">
                    {[{ id: "students", label: "Students" }, { id: "professionals", label: "Working professionals" }, { id: "any", label: "Any" }].map(({ id, label }) => (
                      <label key={id} className="flex items-center gap-1.5 px-2 py-1" style={{ background: newListing.tenantFor === id ? "color-mix(in srgb, var(--marigold) 18%, transparent)" : "var(--kraft)" }}>
                        <input type="radio" name="tenantFor" checked={newListing.tenantFor === id} onChange={() => setNewListing((l) => ({ ...l, tenantFor: id }))} /> {label}
                      </label>
                    ))}
                  </div>
                </div>
                <GoogleLocationPicker value={newListing.location} onChange={(loc) => setNewListing((l) => ({ ...l, location: loc }))} />
                <div className="grid grid-cols-2 gap-3">
                  <select value={newListing.area} onChange={(e) => setNewListing((l) => ({ ...l, area: e.target.value }))} className={field} style={fieldStyle}>{cityAreas.map((a) => <option key={a} value={a}>{a}</option>)}</select>
                  <input type="number" placeholder="Monthly rent" value={newListing.rent} onChange={(e) => setNewListing((l) => ({ ...l, rent: e.target.value }))} className={field} style={fieldStyle} />
                  <select value={newListing.type} onChange={(e) => setNewListing((l) => ({ ...l, type: e.target.value }))} className={field} style={fieldStyle}>{["Single", "2-sharing", "3-sharing", "4-sharing", "2BHK flat"].map((t) => <option key={t}>{t}</option>)}</select>
                  <select value={newListing.gender} onChange={(e) => setNewListing((l) => ({ ...l, gender: e.target.value }))} className={field} style={fieldStyle}>{["Any", "Female", "Male"].map((t) => <option key={t}>{t}</option>)}</select>
                </div>
                <div className="flex gap-4 text-sm pt-1">
                  <label className="flex items-center gap-1.5"><input type="checkbox" checked={newListing.food} onChange={(e) => setNewListing((l) => ({ ...l, food: e.target.checked }))} /> Food included</label>
                  <label className="flex items-center gap-1.5"><input type="checkbox" checked={newListing.wifi} onChange={(e) => setNewListing((l) => ({ ...l, wifi: e.target.checked }))} /> Wifi included</label>
                </div>
                <textarea placeholder="Anything renters should know?" value={newListing.notes} onChange={(e) => setNewListing((l) => ({ ...l, notes: e.target.value }))} className="w-full text-sm px-3 py-2 h-20" style={{ border: "1px dashed color-mix(in srgb, var(--ink) 30%, transparent)", background: "var(--kraft)" }} />

                <div className="pt-3" style={{ borderTop: "1px dashed color-mix(in srgb, var(--ink) 20%, transparent)" }}>
                  <p className="text-xs font-mono uppercase tracking-wide mb-2" style={{ color: "color-mix(in srgb, var(--ink) 50%, transparent)" }}>Cooling &amp; flat type &amp; dimensions</p>
                  <select aria-label="AC or Non-AC" value={newListing.ac} onChange={(e) => setNewListing((l) => ({ ...l, ac: normalizeAc(e.target.value) }))} className={field + " mb-3"} style={fieldStyle}><option value="">AC / Non-AC (not specified)</option>{AC_VALUES.map((v) => <option key={v} value={v}>{v}</option>)}</select>
                  <div className="grid grid-cols-3 gap-3">
                    <select value={newListing.bhk} onChange={(e) => setNewListing((l) => ({ ...l, bhk: e.target.value }))} className={field} style={fieldStyle}>{BHK_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}</select>
                    <input type="number" min={0} placeholder="Area (e.g. 1050)" value={newListing.dimensionValue} onChange={(e) => handleDimensionChange(e.target.value)} className={field} style={fieldStyle} />
                    <select value={newListing.dimensionType} onChange={(e) => setNewListing((l) => ({ ...l, dimensionType: e.target.value }))} className={field} style={fieldStyle}>{DIMENSION_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}</select>
                  </div>
                  {newListing.dimensionValue && <p className="text-[11px] mt-1 font-mono" style={{ color: "color-mix(in srgb, var(--ink) 45%, transparent)" }}>Will show as: {formatAreaSqft(newListing.dimensionValue)} ({newListing.dimensionType})</p>}
                </div>

                <div className="pt-3" style={{ borderTop: "1px dashed color-mix(in srgb, var(--ink) 20%, transparent)" }}>
                  <p className="text-xs font-mono uppercase tracking-wide mb-2" style={{ color: "color-mix(in srgb, var(--ink) 50%, transparent)" }}>Flat photos</p>
                  <p className="text-[11px] mb-2" style={{ color: "color-mix(in srgb, var(--ink) 45%, transparent)" }}>Upload real photographs of the flat — living room, bedroom, kitchen, bathroom, balcony, exterior. Up to 10 photos.</p>
                  <label className="flex items-center justify-center gap-2 w-full py-3 text-xs font-bold uppercase cursor-pointer" style={{ border: "1px dashed color-mix(in srgb, var(--ink) 30%, transparent)", background: "var(--kraft)", color: "var(--ink)" }}>
                    <Plus size={14} /> Add photos
                    <input type="file" accept="image/*" multiple className="hidden" onChange={(e) => { handleListingPhotoUpload(e.target.files); e.target.value = ""; }} />
                  </label>
                  {photoUploadError && <p className="text-xs mt-1.5" style={{ color: "var(--stamp)" }}>{photoUploadError}</p>}
                  {newListing.photos.length > 0 && (
                    <div className="grid grid-cols-4 gap-2 mt-2">
                      {newListing.photos.map((ph, idx) => (
                        <div key={ph.id} className="relative aspect-square overflow-hidden" style={{ border: "1px solid color-mix(in srgb, var(--ink) 15%, transparent)" }}>
                          <img src={ph.dataUrl} alt={`Flat photo ${idx + 1}${ph.caption ? `: ${ph.caption}` : ""}`} className="w-full h-full object-cover" loading="lazy" />
                          <button type="button" onClick={() => removeListingPhoto(ph.id)} aria-label="Remove photo" className="absolute top-0.5 right-0.5 w-5 h-5 flex items-center justify-center" style={{ background: "rgba(20,26,34,0.75)" }}><X size={12} color="#fff" /></button>
                          {idx === 0 && <span className="absolute bottom-0.5 left-0.5 text-[9px] font-mono font-bold uppercase px-1" style={{ background: "var(--marigold)", color: "var(--ink)" }}>Primary</span>}
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <button disabled={!newListing.title} onClick={() => { if (newListing.location) setChecklist((c) => ({ ...c, address: true })); if (newListing.photos.length) setChecklist((c) => ({ ...c, photos: true })); setListStep("verify"); }} className="w-full py-2.5 text-sm font-bold uppercase tracking-wide disabled:opacity-40" style={{ background: "var(--marigold)", color: "var(--ink)" }}>Continue to verification</button>
              </div>
            </>
          )}
          {listStep === "verify" && (
            <>
              <button onClick={() => setListStep("form")} className="flex items-center gap-1 text-sm mb-4 font-mono" style={{ color: "var(--ink)" }}><ChevronLeft size={15} /> Back</button>
              <SectionTitle sub="Verified listings get 3x more enquiries and show a trust badge to renters.">Verification checklist</SectionTitle>
              <div className="space-y-3 p-5" style={{ background: "var(--paper)", border: "1px solid color-mix(in srgb, var(--ink) 12%, transparent)" }}>
                {[{ key: "id", label: "Government ID uploaded (Aadhaar / PAN / Voter ID)" }, { key: "ownership", label: "Ownership proof or rent agreement uploaded" }, { key: "photos", label: "At least 3 property photos uploaded" }, { key: "address", label: "Address confirmed via pin location" }].map(({ key, label }) => (
                  <label key={key} className="flex items-center gap-2 text-sm p-2" style={{ background: "var(--kraft)" }}><input type="checkbox" checked={checklist[key]} onChange={(e) => setChecklist((c) => ({ ...c, [key]: e.target.checked }))} /> {label}</label>
                ))}
                <button disabled={!checklistDone} onClick={submitListing} className="w-full py-2.5 text-sm font-bold uppercase tracking-wide disabled:opacity-40" style={{ background: "var(--panel)", color: "var(--panel-text)" }}>Submit for verification</button>
              </div>
            </>
          )}
          {listStep === "done" && (
            <div className="text-center py-10">
              <Stamp color="var(--sage)" rotate={-8} style={{ fontSize: 13, padding: "6px 14px", borderWidth: 2 }}><CheckCircle2 size={16} /> Submitted</Stamp>
              <p className="mt-4" style={{ ...HEAD, fontSize: 24 }}>Listing submitted</p>
              <p className="text-sm mt-1 mb-6" style={{ color: "color-mix(in srgb, var(--ink) 60%, transparent)" }}>It's live under "Not verified" in {selectedCity} until review is complete.</p>
              <button onClick={() => { setListStep("form"); setNewListing({ title: "", area: cityAreas[0] || "Kamla Nagar", rent: 9000, type: "2-sharing", gender: "Any", tenantFor: audienceForPersona(persona), food: false, wifi: false, notes: "", location: null, ac: "", bhk: "Not specified", dimensionValue: "", dimensionType: "Carpet Area", photos: [] }); setChecklist({ id: false, ownership: false, photos: false, address: false }); }} className="px-4 py-2 text-sm font-bold uppercase" style={{ background: "var(--marigold)", color: "var(--ink)" }}>List another property</button>
            </div>
          )}
          {myListings.length > 0 && (
            <div className="mt-10">
              <h3 style={{ ...HEAD, fontSize: 20 }} className="mb-3">My listings</h3>
              <div className="space-y-4">
                {myListings.map((p, i) => (
                  <Notice key={p.id} i={i} className="p-4 flex items-center justify-between gap-3 flex-wrap">
                    <div><p className="font-bold text-sm">{p.title} {p.premium && <Award size={13} className="inline ml-1 mb-0.5" style={{ color: "var(--marigold)" }} />} <span className="font-normal text-xs" style={{ color: "color-mix(in srgb, var(--ink) 50%, transparent)" }}>&middot; {p.city}</span></p><div className="mt-1"><StatusStamp status={p.status} /></div></div>
                    <div className="flex gap-2">
                      {p.status === "pending" && <button onClick={() => verifyListing(p.id)} className="text-xs font-mono font-bold uppercase px-3 py-1.5" style={{ background: "color-mix(in srgb, var(--sage) 15%, transparent)", color: "var(--sage)" }}>Admin verifies</button>}
                      {p.status === "verified" && !p.premium && <button onClick={() => boostToPremium(p.id)} className="flex items-center gap-1 text-xs font-mono font-bold uppercase px-3 py-1.5" style={{ background: "color-mix(in srgb, var(--marigold) 18%, transparent)", color: "var(--marigold)" }}><Award size={12} /> Boost — ₹{PREMIUM_FEE}</button>}
                    </div>
                  </Notice>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ---------------- Partners tab ---------------- */}
      {tab === "partners" && (
        <div className="max-w-2xl mx-auto px-6 sm:px-10 py-8">
          {persona === "professional" ? (
            <>
              <SectionTitle sub="Verify with your work email and office ID domain — corporate partners, not colleges.">Company partnerships</SectionTitle>
              <div className="p-5 mb-6" style={{ background: "var(--paper)", border: "1px solid color-mix(in srgb, var(--ink) 12%, transparent)" }}>
                <label className="text-xs font-mono uppercase tracking-wide" style={{ color: "color-mix(in srgb, var(--ink) 50%, transparent)" }}>Work email (office ID)</label>
                <div className="flex gap-2 mt-1"><input placeholder="you@infosys.com" value={officeEmail} onChange={(e) => setOfficeEmail(e.target.value)} className={field} style={fieldStyle} /><button type="button" onClick={verifyOfficeEmail} className="px-4 py-2 text-sm font-bold uppercase" style={{ background: "var(--marigold)", color: "var(--ink)" }}>Verify</button></div>
                {partner?.kind === "company" && <p className="flex items-center gap-1.5 text-sm mt-3" style={{ color: "var(--sage)" }}><CheckCircle2 size={15} /> Verified with {partner.name} — {partner.perk.toLowerCase()}.</p>}
                {officeEmail && partner?.kind !== "company" && <p className="text-sm mt-3" style={{ color: "color-mix(in srgb, var(--ink) 50%, transparent)" }}>That domain isn't a partner company yet — try one listed below.</p>}
              </div>
              <h3 style={{ ...HEAD, fontSize: 20 }} className="mb-3">Partner companies</h3>
              <div className="space-y-4">
                {PARTNER_COMPANIES.map((c, i) => (
                  <Notice key={c.domain} i={i} className="p-4 flex items-center gap-4" pinColor={partner?.domain === c.domain ? "var(--sage)" : undefined} style={{ transform: `rotate(${tilt(i)})`, outline: partner?.domain === c.domain ? "2px solid var(--sage)" : "none" }}>
                    <div className="w-11 h-11 flex items-center justify-center flex-shrink-0" style={{ background: "var(--panel)" }}><Briefcase size={18} style={{ color: "var(--marigold)" }} /></div>
                    <div><p className="font-bold text-sm">{c.name}</p><p className="text-xs mt-0.5" style={{ color: "color-mix(in srgb, var(--ink) 60%, transparent)" }}>{c.perk} &middot; <span className="font-mono">@{c.domain}</span></p></div>
                  </Notice>
                ))}
              </div>
            </>
          ) : (
            <>
              <SectionTitle sub="Students verify a college email — perks differ from the professional corporate program.">College partnerships</SectionTitle>
              <div className="p-5 mb-6" style={{ background: "var(--paper)", border: "1px solid color-mix(in srgb, var(--ink) 12%, transparent)" }}>
                <label className="text-xs font-mono uppercase tracking-wide" style={{ color: "color-mix(in srgb, var(--ink) 50%, transparent)" }}>College email</label>
                <div className="flex gap-2 mt-1"><input placeholder="you@du.ac.in" value={collegeEmail} onChange={(e) => setCollegeEmail(e.target.value)} className={field} style={fieldStyle} /><button type="button" onClick={verifyCollegeEmail} className="px-4 py-2 text-sm font-bold uppercase" style={{ background: "var(--marigold)", color: "var(--ink)" }}>Verify</button></div>
                {partner?.kind === "college" && <p className="flex items-center gap-1.5 text-sm mt-3" style={{ color: "var(--sage)" }}><CheckCircle2 size={15} /> Verified with {partner.name} — {partner.perk.toLowerCase()}.</p>}
                {collegeEmail && partner?.kind !== "college" && <p className="text-sm mt-3" style={{ color: "color-mix(in srgb, var(--ink) 50%, transparent)" }}>That domain isn't a partner college yet — try one listed below.</p>}
              </div>
              <h3 style={{ ...HEAD, fontSize: 20 }} className="mb-3">Partner colleges</h3>
              <div className="space-y-4">
                {PARTNER_COLLEGES.map((c, i) => (
                  <Notice key={c.domain} i={i} className="p-4 flex items-center gap-4" pinColor={partner?.domain === c.domain ? "var(--sage)" : undefined} style={{ transform: `rotate(${tilt(i)})`, outline: partner?.domain === c.domain ? "2px solid var(--sage)" : "none" }}>
                    <div className="w-11 h-11 flex items-center justify-center flex-shrink-0" style={{ background: "var(--panel)" }}><Building2 size={18} style={{ color: "var(--marigold)" }} /></div>
                    <div><p className="font-bold text-sm">{c.name}</p><p className="text-xs mt-0.5" style={{ color: "color-mix(in srgb, var(--ink) 60%, transparent)" }}>{c.perk} &middot; <span className="font-mono">@{c.domain}</span></p></div>
                  </Notice>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {/* property detail modal */}
      {selected && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-6 overflow-y-auto" style={{ background: "rgba(20,26,34,0.6)" }} onClick={() => { setSelected(null); setReviewDraft({ rating: 0, text: "" }); }}>
          <div className="w-full sm:max-w-md overflow-hidden my-auto" style={{ background: "var(--paper)", borderRadius: 4, boxShadow: "0 20px 40px -10px rgba(0,0,0,0.4)" }} onClick={(e) => e.stopPropagation()}>
            {selected.photos?.length > 0 ? (
              <div className="relative h-56" style={{ background: "var(--panel)" }}>
                <img src={selected.photos[galleryIndex]?.dataUrl} alt={`${selected.title} — photo ${galleryIndex + 1} of ${selected.photos.length}${selected.photos[galleryIndex]?.caption ? `: ${selected.photos[galleryIndex].caption}` : ""}`} className="w-full h-full object-cover" />
                <button onClick={() => setSelected(null)} aria-label="Close" className="absolute top-3 right-3 w-8 h-8 flex items-center justify-center" style={{ background: "rgba(20,26,34,0.6)" }}><X size={16} color="#fff" /></button>
                {selected.photos.length > 1 && (
                  <>
                    <button onClick={() => setGalleryIndex((i) => (i - 1 + selected.photos.length) % selected.photos.length)} aria-label="Previous photo" className="absolute left-2 top-1/2 -translate-y-1/2 no-lift w-8 h-8 flex items-center justify-center" style={{ background: "rgba(20,26,34,0.55)" }}><ChevronLeft size={16} color="#fff" /></button>
                    <button onClick={() => setGalleryIndex((i) => (i + 1) % selected.photos.length)} aria-label="Next photo" className="absolute right-2 top-1/2 -translate-y-1/2 no-lift w-8 h-8 flex items-center justify-center" style={{ background: "rgba(20,26,34,0.55)", transform: "translateY(-50%) scaleX(-1)" }}><ChevronLeft size={16} color="#fff" /></button>
                    <div className="absolute bottom-2 left-0 right-0 flex items-center justify-center gap-1.5">
                      {selected.photos.map((_, i) => <span key={i} style={{ width: 6, height: 6, borderRadius: 999, background: i === galleryIndex ? "#fff" : "rgba(255,255,255,0.45)" }} />)}
                    </div>
                  </>
                )}
              </div>
            ) : (
              <div className="relative h-52 flex items-center justify-center overflow-hidden" style={{ background: "var(--panel)" }}>
                <CardImage src={coverFor(selected)} alt={`${selected.title} — cover photo`} iconSize={30} />
                <button onClick={() => setSelected(null)} aria-label="Close" className="icon-hover-btn absolute top-3 right-3 w-8 h-8 flex items-center justify-center" style={{ background: "rgba(20,26,34,0.6)" }}><X size={16} color="#fff" /></button>
              </div>
            )}
            <div className="p-5">
              <div className="flex items-start justify-between gap-2"><h3 style={{ ...HEAD, fontSize: 24 }}>{selected.title}</h3><StatusStamp status={selected.status} /></div>
              <p className="flex items-center gap-1 text-sm mt-1" style={{ color: "color-mix(in srgb, var(--ink) 60%, transparent)" }}><MapPin size={13} /> {selected.area}, {selected.city} &middot; {selected.dist} km {distLabel}</p>
              {(selected.bhk && selected.bhk !== "Not specified") || formatAreaSqft(selected.dimensionValue) ? (
                <p className="flex items-center gap-2 text-xs mt-1.5 font-mono">
                  {selected.bhk && selected.bhk !== "Not specified" && <span style={{ color: "var(--sage)" }} className="font-bold">{selected.bhk}</span>}
                  {formatAreaSqft(selected.dimensionValue) && <span style={{ color: "color-mix(in srgb, var(--ink) 55%, transparent)" }}>{formatAreaSqft(selected.dimensionValue)}{selected.dimensionType ? ` (${selected.dimensionType})` : ""}</span>}
                </p>
              ) : null}

              {/* ---- Map: locked behind subscription for tenants; owners always see it ---- */}
              {(() => {
                const canSeeMap = currentUser.role === "lister" || !!subscription?.active;
                const embed = canSeeMap && mapsEmbedSrc({ lat: selected.lat, lng: selected.lng, query: selected.locationLabel || `${selected.area}, ${selected.city}` });
                if (embed) {
                  return (
                    <div className="mt-3 overflow-hidden" style={{ border: "1px solid color-mix(in srgb, var(--ink) 12%, transparent)", borderRadius: 4 }}>
                      <iframe title="Listing map" src={embed} width="100%" height={160} style={{ border: 0 }} loading="lazy" referrerPolicy="no-referrer-when-downgrade" />
                      {!isOwner && selected.ownerPhone && (
                        <a href={`tel:${selected.ownerPhone}`} className="flex items-center justify-center gap-1.5 w-full py-2 text-xs font-bold uppercase" style={{ background: "var(--sage)", color: "white" }}><MessageSquare size={13} /> Contact owner directly — no broker</a>
                      )}
                    </div>
                  );
                }
                return (
                  <div className="mt-3 p-3" style={{ background: "var(--kraft)", border: "1px dashed color-mix(in srgb, var(--ink) 25%, transparent)", borderRadius: 4 }}>
                    <p className="text-[11px] font-mono uppercase tracking-wide" style={{ color: "color-mix(in srgb, var(--ink) 50%, transparent)" }}>Approximate location</p>
                    <p className="flex items-center gap-1.5 text-sm mt-1 font-medium"><MapPin size={13} /> {selected.locationLabel || `${selected.area}, ${selected.city}`}</p>
                    <p className="text-xs mt-1.5" style={{ color: "color-mix(in srgb, var(--ink) 60%, transparent)" }}>Subscribe to unlock the property map and contact the owner directly — no broker.</p>
                    <button type="button" onClick={() => setMapPaywallOpen(true)} className="w-full mt-2 py-2 text-xs font-bold uppercase" style={{ background: "var(--marigold)", color: "var(--ink)" }}>Unlock map &amp; direct contact</button>
                  </div>
                );
              })()}

              <p className="font-mono text-2xl font-bold mt-3" style={{ color: "var(--ink)" }}>₹{selected.rent.toLocaleString("en-IN")}<span className="text-sm font-normal" style={{ color: "color-mix(in srgb, var(--ink) 50%, transparent)" }}> /month</span></p>
              <p className="text-sm mt-3" style={{ color: "color-mix(in srgb, var(--ink) 75%, transparent)" }}>{selected.notes}</p>
              <div className="flex flex-wrap gap-2 mt-4">
                <span className="text-xs px-2.5 py-1" style={{ background: "var(--kraft)" }}>{selected.type}</span>
                <span className="text-xs px-2.5 py-1" style={{ background: "var(--kraft)" }}>{selected.gender} preferred</span>
                {selected.food && <span className="text-xs px-2.5 py-1 flex items-center gap-1" style={{ background: "var(--kraft)" }}><UtensilsCrossed size={12} /> Food included</span>}
                {normalizeAc(selected.ac) && <span className="text-xs px-2.5 py-1" style={{ background: "var(--kraft)" }}>{normalizeAc(selected.ac)}</span>}
                {selected.wifi && <span className="text-xs px-2.5 py-1 flex items-center gap-1" style={{ background: "var(--kraft)" }}><Wifi size={12} /> Wifi</span>}
              </div>
              {isOwner ? (
                <p className="mt-5 text-xs font-mono p-3" style={{ background: "var(--kraft)", border: "1px dashed color-mix(in srgb, var(--ink) 25%, transparent)", borderRadius: 4, color: "color-mix(in srgb, var(--ink) 65%, transparent)" }}>OWNER VIEW — tenants see the reserve &amp; review options here.</p>
              ) : (<>
              <button onClick={() => reserveRoom(selected)} disabled={reserved[selected.id]} className="w-full mt-5 py-2.5 text-sm font-bold uppercase tracking-wide disabled:opacity-60" style={{ background: reserved[selected.id] ? "var(--sage)" : "var(--marigold)", color: reserved[selected.id] ? "white" : "var(--ink)" }}>{reserved[selected.id] ? "Reserved — owner notified" : partner ? `Reserve room — free with ${partner.name}` : `Reserve room — pay ₹${TOKEN_AMOUNT} token`}</button>
              {reserved[selected.id] && !signedIds[selected.id] && <button onClick={() => setAgreementFor(selected)} className="w-full mt-2 flex items-center justify-center gap-1.5 py-2 text-xs font-bold uppercase" style={{ background: "var(--kraft)", color: "var(--ink)" }}><FileText size={13} /> Sign digital rental agreement</button>}
              {signedIds[selected.id] && <p className="flex items-center justify-center gap-1.5 text-xs mt-2" style={{ color: "var(--sage)" }}><CheckCircle2 size={13} /> Agreement signed &amp; downloaded</p>}
              </>)}

              <div className="mt-6 pt-5" style={{ borderTop: "1px dashed color-mix(in srgb, var(--ink) 20%, transparent)" }}>
                <h4 className="flex items-center gap-1.5 font-bold text-sm mb-3"><MessageSquare size={14} /> Reviews {selected.reviews.length > 0 && `(${selected.reviews.length})`}</h4>
                {selected.reviews.length === 0 ? <p className="text-sm" style={{ color: "color-mix(in srgb, var(--ink) 50%, transparent)" }}>No reviews yet — be the first.</p> : (
                  <div className="space-y-3 max-h-40 overflow-y-auto pr-1">
                    {selected.reviews.map((r) => (
                      <div key={r.id}>
                        <div className="flex items-center gap-2"><span className="text-sm font-medium">{r.author}</span><span className="flex">{Array.from({ length: r.rating }).map((_, i) => <Star key={i} size={11} fill="var(--marigold)" style={{ color: "var(--marigold)" }} />)}</span><span className="text-[11px] font-mono" style={{ color: "color-mix(in srgb, var(--ink) 40%, transparent)" }}>{r.date}</span></div>
                        <p className="text-sm mt-0.5" style={{ color: "color-mix(in srgb, var(--ink) 75%, transparent)" }}>{r.text}</p>
                      </div>
                    ))}
                  </div>
                )}
                {!isOwner && <div className="mt-4 p-3" style={{ background: "var(--kraft)" }}>
                  <p className="text-xs font-mono uppercase tracking-wide mb-2" style={{ color: "color-mix(in srgb, var(--ink) 50%, transparent)" }}>Leave a review</p>
                  <StarPicker value={reviewDraft.rating} onChange={(n) => setReviewDraft((d) => ({ ...d, rating: n }))} />
                  <textarea placeholder="How was your stay?" value={reviewDraft.text} onChange={(e) => setReviewDraft((d) => ({ ...d, text: e.target.value }))} className="w-full text-sm px-3 py-2 mt-2 h-16" style={{ border: "1px dashed color-mix(in srgb, var(--ink) 30%, transparent)", background: "var(--paper)" }} />
                  <button onClick={submitReview} disabled={!reviewDraft.rating} className="mt-2 px-4 py-1.5 text-xs font-bold uppercase disabled:opacity-40" style={{ background: "var(--panel)", color: "var(--panel-text)" }}>Post review</button>
                </div>}
              </div>
            </div>
          </div>
        </div>
      )}

      <PaymentModal info={payment} onClose={() => setPayment(null)} onSuccess={() => payment?.onDone?.()} />
      <AgreementModal property={agreementFor} studentName={studentName} setStudentName={setStudentName} onClose={() => setAgreementFor(null)} onSigned={() => setSignedIds((prev) => ({ ...prev, [agreementFor.id]: true }))} />
      <MapSubscribeModal open={mapPaywallOpen} onClose={() => setMapPaywallOpen(false)} plans={SUBSCRIPTION_PLANS.customer} subBusy={subBusy} onActivate={async (plan) => { await activateSubscription(plan); setMapPaywallOpen(false); }} />

      <div className="basera-footer text-center py-8 mt-8 text-xs font-mono" style={{ color: "color-mix(in srgb, var(--ink) 50%, transparent)", borderTop: "1px solid color-mix(in srgb, var(--ink) 10%, transparent)" }}>
        BASERA &middot; NATIONAL ROLLOUT &middot; ROOMS, ROOMMATES, LIVING &amp; MORE
      </div>
    </div>
  );
}
