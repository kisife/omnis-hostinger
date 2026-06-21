import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import "dotenv/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── JWT Helpers ────────────────────────────────────────────────
const JWT_SECRET = process.env.JWT_SECRET || "omnis-default-secret-change-me-in-production";

function signJWT(payload, expiresInSeconds = 604800) {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const exp = Math.floor(Date.now() / 1000) + expiresInSeconds;
  const body = Buffer.from(JSON.stringify({ ...payload, exp, iat: Math.floor(Date.now() / 1000) })).toString("base64url");
  const signature = createHmac("sha256", JWT_SECRET).update(`${header}.${body}`).digest("base64url");
  return `${header}.${body}.${signature}`;
}

function verifyJWT(token) {
  try {
    const [header, body, signature] = token.split(".");
    if (!header || !body || !signature) return null;
    const expectedSignature = createHmac("sha256", JWT_SECRET).update(`${header}.${body}`).digest("base64url");
    if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) return null;
    const payload = JSON.parse(Buffer.from(body, "base64url").toString());
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

function getTokenFromHeader(c) {
  const auth = c.req.header("Authorization") || "";
  if (auth.startsWith("Bearer ")) return auth.slice(7);
  return null;
}

function getCurrentUser(c) {
  const token = getTokenFromHeader(c);
  if (!token) return null;
  const payload = verifyJWT(token);
  if (!payload || !payload.userId) return null;
  return sqlite.prepare("SELECT id, unionId, name, email, avatar, role, createdAt, updatedAt, lastSignInAt FROM users WHERE id = ?").get(payload.userId) || null;
}

function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const hash = createHmac("sha256", JWT_SECRET + salt).update(password).digest("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const expected = createHmac("sha256", JWT_SECRET + salt).update(password).digest("hex");
  return timingSafeEqual(Buffer.from(hash), Buffer.from(expected));
}

// ── OAuth Config ─────────────────────────────────────────────────
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID || "";
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET || "";
const OAUTH_REDIRECT_URL = process.env.OAUTH_REDIRECT_URL || "https://www.kisife.com";

// ── OAuth State ─────────────────────────────────────────────────
const oauthStates = new Map();
function generateState() {
  const state = randomBytes(16).toString("hex");
  oauthStates.set(state, Date.now() + 10 * 60 * 1000);
  return state;
}
function verifyState(state) {
  if (!state || !oauthStates.has(state)) return false;
  oauthStates.delete(state);
  return true;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of oauthStates) { if (v < now) oauthStates.delete(k); }
}, 60000);

// ── Initialize SQLite ──────────────────────────────────────────
const dbPath = path.join(__dirname, "omnis.db");
const sqlite = new Database(dbPath);
sqlite.exec("PRAGMA journal_mode = WAL;");
sqlite.exec("PRAGMA foreign_keys = ON;");

// ── Schema migrations ────────────────────────────────────────────
// Add new columns if they don't exist (SQLite ALTER TABLE is safe to re-run)
try { sqlite.exec("ALTER TABLE contracts ADD COLUMN approved_at INTEGER"); } catch {}
try { sqlite.exec("ALTER TABLE contracts ADD COLUMN approved_by INTEGER"); } catch {}
try { sqlite.exec("ALTER TABLE website_projects ADD COLUMN staging_url TEXT"); } catch {}
try { sqlite.exec("ALTER TABLE website_projects ADD COLUMN approved_at INTEGER"); } catch {}
try { sqlite.exec("CREATE TABLE IF NOT EXISTS contract_approvals (id INTEGER PRIMARY KEY AUTOINCREMENT, contract_id INTEGER NOT NULL, approver_id INTEGER, action TEXT NOT NULL, notes TEXT, created_at INTEGER NOT NULL)"); } catch {}

// Create tables
sqlite.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  unionId TEXT NOT NULL UNIQUE,
  name TEXT,
  email TEXT UNIQUE,
  password TEXT,
  avatar TEXT,
  role TEXT DEFAULT 'user' NOT NULL,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL,
  lastSignInAt INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS business_leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_name TEXT NOT NULL,
  category TEXT,
  address TEXT,
  phone TEXT,
  email TEXT,
  has_website INTEGER DEFAULT 0,
  discovery_source TEXT,
  status TEXT DEFAULT 'new',
  assigned_agent TEXT,
  notes TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS website_projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER NOT NULL,
  project_name TEXT,
  status TEXT DEFAULT 'draft',
  design_url TEXT,
  template_used TEXT,
  pages_built INTEGER DEFAULT 0,
  total_pages INTEGER DEFAULT 5,
  build_progress INTEGER DEFAULT 0,
  preview_url TEXT,
  staging_url TEXT,
  approved_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS proposals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER NOT NULL,
  project_id INTEGER,
  proposal_type TEXT,
  monthly_fee REAL,
  setup_fee REAL,
  total_price REAL,
  included_services TEXT,
  status TEXT DEFAULT 'draft',
  sent_at INTEGER,
  expires_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS contracts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  proposal_id INTEGER NOT NULL,
  lead_id INTEGER NOT NULL,
  contract_type TEXT,
  contract_status TEXT DEFAULT 'draft',
  contract_content TEXT,
  signature_url TEXT,
  signed_at INTEGER,
  expires_at INTEGER,
  monthly_recurring_revenue REAL,
  approved_at INTEGER,
  approved_by INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS contract_approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contract_id INTEGER NOT NULL,
  approver_id INTEGER,
  action TEXT NOT NULL,
  notes TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS clients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER NOT NULL,
  contract_id INTEGER NOT NULL,
  client_status TEXT DEFAULT 'active',
  website_url TEXT,
  last_payment_at INTEGER,
  next_payment_at INTEGER,
  total_revenue REAL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  amount REAL NOT NULL,
  payment_type TEXT,
  status TEXT DEFAULT 'pending',
  paid_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_name TEXT,
  agent_type TEXT,
  action TEXT,
  target_lead_id INTEGER,
  status TEXT,
  metadata TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS workflow_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow_name TEXT,
  workflow_type TEXT,
  status TEXT,
  steps_completed INTEGER DEFAULT 0,
  total_steps INTEGER DEFAULT 0,
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  error_message TEXT
);
`);

// ── Seed data ────────────────────────────────────────────────────
const now = Date.now();
const day = 86400000;

const clientsCount = sqlite.prepare("SELECT COUNT(*) as c FROM clients").get();
if (clientsCount.c === 0) {
  sqlite.exec("DELETE FROM users");
  sqlite.exec("DELETE FROM agent_logs");
  sqlite.exec("DELETE FROM workflow_runs");
  sqlite.exec("DELETE FROM payments");
  sqlite.exec("DELETE FROM clients");
  sqlite.exec("DELETE FROM contract_approvals");
  sqlite.exec("DELETE FROM contracts");
  sqlite.exec("DELETE FROM proposals");
  sqlite.exec("DELETE FROM website_projects");
  sqlite.exec("DELETE FROM business_leads");
  
  const leads = [
    ["Sunrise Bakery", "Food & Beverage", "123 Main St, Austin, TX", "(512) 555-0101", "hello@sunrisebakery.com", 0, "google_maps", "contacted", "Agent Alpha", "No website. Only Facebook page.", now-30*day, now-2*day],
    ["Downtown Dental Care", "Healthcare", "456 Oak Ave, Portland, OR", "(503) 555-0202", "info@downtowndental.com", 0, "yelp_scraper", "qualified", "Agent Beta", "Established practice, 4.8 stars on Yelp.", now-45*day, now-5*day],
    ["Elite Fitness Studio", "Fitness & Wellness", "789 Gym Blvd, Miami, FL", "(305) 555-0303", "contact@elitefitness.com", 0, "facebook_ads", "new", "Agent Gamma", "Instagram only. No booking system.", now-7*day, now-7*day],
    ["River Valley Plumbing", "Home Services", "321 River Rd, Denver, CO", "(720) 555-0404", "service@rivervalleyplumbing.com", 0, "google_maps", "negotiating", "Agent Delta", "Family business 15 years.", now-60*day, now-1*day],
    ["Parkside Cafe & Books", "Retail & Hospitality", "654 Park Ln, Seattle, WA", "(206) 555-0505", "hello@parksidecafe.com", 0, "yelp_scraper", "qualified", "Agent Alpha", "Unique concept. 4.9 stars.", now-14*day, now-3*day],
    ["Golden Paws Pet Grooming", "Pet Services", "753 Bark Ave, San Diego, CA", "(619) 555-1010", "groom@goldenpaws.com", 0, "google_maps", "closed_won", "Agent Beta", "Converted! Full ownership package.", now-120*day, now-30*day],
    ["Precision Tax Advisors", "Professional Services", "579 Number St, Atlanta, GA", "(404) 555-1616", "tax@precisionadvisors.com", 0, "google_maps", "closed_won", "Agent Delta", "Converted! Subscription model.", now-150*day, now-45*day],
  ];
  const insertLead = sqlite.prepare("INSERT INTO business_leads (business_name, category, address, phone, email, has_website, discovery_source, status, assigned_agent, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  for (const l of leads) insertLead.run(...l);

  const proposals = [
    [6, null, "full_ownership", 0, 0, 2499, "Website design, development, deployment", "accepted", now-110*day, now-80*day, now-110*day],
    [7, null, "subscription", 149, 499, 0, "Managed hosting, updates, security", "accepted", now-140*day, now-110*day, now-140*day],
  ];
  const insertProposal = sqlite.prepare("INSERT INTO proposals (lead_id, project_id, proposal_type, monthly_fee, setup_fee, total_price, included_services, status, sent_at, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  for (const p of proposals) insertProposal.run(...p);

  const contracts = [
    [1, 6, "full_ownership", "signed", "Full ownership $2,499", null, now-105*day, now+365*day, 0, 1, now-110*day, now-105*day],
    [2, 7, "subscription", "signed", "Annual subscription $149/mo", null, now-135*day, now+365*day, 149, 1, now-140*day, now-135*day],
    [null, 3, "full_ownership", "pending_approval", "Website design package $1,999 for Elite Fitness. Includes 5 pages, booking system, mobile responsive.", null, null, null, 0, null, null, now-5*day],
    [null, 4, "subscription", "draft", "Monthly subscription $149/mo for River Valley Plumbing. Includes hosting, updates, support.", null, null, null, 149, null, null, now-2*day],
  ];
  const insertContract = sqlite.prepare("INSERT INTO contracts (proposal_id, lead_id, contract_type, contract_status, contract_content, signature_url, signed_at, expires_at, monthly_recurring_revenue, approved_by, approved_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  for (const c of contracts) insertContract.run(...c);

  const projects = [
    [6, "Golden Paws Website", "approved", null, "pet_grooming_v2", 6, 6, 100, "https://goldenpaws.com", "https://staging.goldenpaws.com", now-70*day, now-60*day, now-60*day],
    [7, "Precision Tax Website", "approved", null, "professional_v1", 5, 5, 100, "https://precisiontax.com", "https://staging.precisiontax.com", now-120*day, now-110*day, now-110*day],
    [3, "Elite Fitness Website", "staging", null, "fitness_v3", 3, 5, 60, null, "https://staging.elitefitness.com", null, now-3*day, now-3*day],
  ];
  const insertProject = sqlite.prepare("INSERT INTO website_projects (lead_id, project_name, status, design_url, template_used, pages_built, total_pages, build_progress, preview_url, staging_url, approved_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  for (const p of projects) insertProject.run(...p);

  const clients = [
    [6, 1, "active", "https://goldenpaws.com", now-30*day, null, 2499, now-120*day],
    [7, 2, "active", "https://precisiontax.com", now-15*day, now+15*day, 1294, now-150*day],
  ];
  const insertClient = sqlite.prepare("INSERT INTO clients (lead_id, contract_id, client_status, website_url, last_payment_at, next_payment_at, total_revenue, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  for (const c of clients) insertClient.run(...c);

  const payments = [
    [1, 2499, "full_payment", "completed", now-100*day, now-100*day],
    [2, 499, "setup_fee", "completed", now-135*day, now-135*day],
    [2, 149, "subscription", "completed", now-105*day, now-105*day],
    [2, 149, "subscription", "completed", now-75*day, now-75*day],
    [2, 149, "subscription", "completed", now-45*day, now-45*day],
    [2, 149, "subscription", "completed", now-15*day, now-15*day],
  ];
  const insertPayment = sqlite.prepare("INSERT INTO payments (client_id, amount, payment_type, status, paid_at, created_at) VALUES (?, ?, ?, ?, ?, ?)");
  for (const p of payments) insertPayment.run(...p);

  const agentLogs = [
    ["Agent Alpha", "discovery", "scanned_yelp", 1, "success", '{"source": "yelp", "results": 12}', now-30*day],
    ["Agent Beta", "discovery", "scanned_google_maps", 2, "success", '{"source": "maps", "results": 8}', now-45*day],
    ["Agent Gamma", "design", "generated_mockup", 6, "success", '{"template": "pet_grooming_v2", "pages": 6}', now-100*day],
    ["Agent Delta", "development", "deployed_site", 6, "success", '{"url": "https://goldenpaws.com", "pages": 6}', now-60*day],
    ["Agent Alpha", "sales", "sent_proposal", 3, "success", '{"proposal_id": 3, "value": 2499}', now-85*day],
    ["Agent Beta", "marketing", "analyzed_competitors", 4, "success", '{"competitors": 5, "keywords": 12}', now-80*day],
    ["Agent Gamma", "discovery", "scanned_instagram", 3, "success", '{"followers": 3400, "posts": 89}', now-3*day],
    ["Agent Delta", "legal", "generated_contract", 7, "success", '{"contract_type": "subscription", "duration": "annual"}', now-135*day],
    ["Agent Alpha", "operations", "quality_check", 6, "success", '{"score": 98, "issues": 0}', now-55*day],
    ["Agent Beta", "security", "ssl_configured", 7, "success", '{"provider": "Cloudflare", "grade": "A+"}', now-110*day],
  ];
  const insertLog = sqlite.prepare("INSERT INTO agent_logs (agent_name, agent_type, action, target_lead_id, status, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
  for (const l of agentLogs) insertLog.run(...l);

  const workflows = [
    ["Golden Paws Build", "website_creation", "completed", 8, 8, now-100*day, now-60*day, null],
    ["Precision Tax Build", "website_creation", "completed", 8, 8, now-130*day, now-110*day, null],
    ["Discovery Batch #47", "lead_discovery", "completed", 5, 5, now-3*day, now-3*day, null],
    ["Weekly Report Gen", "reporting", "completed", 3, 3, now-1*day, now-1*day, null],
  ];
  const insertWorkflow = sqlite.prepare("INSERT INTO workflow_runs (workflow_name, workflow_type, status, steps_completed, total_steps, started_at, completed_at, error_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  for (const w of workflows) insertWorkflow.run(...w);

  // Seed admin user with password
  const adminPassword = hashPassword("admin123");
  sqlite.prepare("INSERT INTO users (unionId, name, email, password, avatar, role, createdAt, updatedAt, lastSignInAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run("local_1", "Admin", "admin@omnis.systems", adminPassword, null, "admin", now-200*day, now, now);
}

// ── Helper: parse tRPC body ───────────────────────────────────
async function parseBody(c) {
  try {
    const body = await c.req.json();
    return body?.json || body || {};
  } catch {
    return {};
  }
}

// ── Hono App ───────────────────────────────────────────────────
const app = new Hono();

// CORS
app.use("*", async (c, next) => {
  c.header("Access-Control-Allow-Origin", "*");
  c.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  c.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (c.req.method === "OPTIONS") return c.body(null, 204);
  await next();
});

// Body limit
app.use("*", async (c, next) => {
  const contentLength = parseInt(c.req.header("content-length") || "0");
  if (contentLength > 50 * 1024 * 1024) return c.json({ error: "Payload too large" }, 413);
  await next();
});

// Health check
app.get("/api/ping", (c) => c.json({ ok: true, ts: Date.now() }));
app.get("/api/trpc/ping", (c) => c.json({ ok: true, ts: Date.now() }));

// ── Built-in Auth (Email/Password) ─────────────────────────────
app.post("/api/auth/register", async (c) => {
  const body = await parseBody(c);
  const { name, email, password } = body;
  if (!name || !email || !password) return c.json({ error: "Name, email, and password required" }, 400);
  if (password.length < 6) return c.json({ error: "Password must be at least 6 characters" }, 400);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return c.json({ error: "Invalid email" }, 400);
  
  const existing = sqlite.prepare("SELECT id FROM users WHERE email = ?").get(email);
  if (existing) return c.json({ error: "Email already registered" }, 409);
  
  const timestamp = Date.now();
  const hashed = hashPassword(password);
  const unionId = `local_${timestamp}`;
  const result = sqlite.prepare("INSERT INTO users (unionId, name, email, password, avatar, role, createdAt, updatedAt, lastSignInAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(unionId, name, email, hashed, null, "user", timestamp, timestamp, timestamp);
  
  const user = sqlite.prepare("SELECT id, unionId, name, email, avatar, role FROM users WHERE id = ?").get(result.lastInsertRowid);
  const token = signJWT({ userId: user.id, unionId: user.unionId, email: user.email, role: user.role });
  return c.json({ result: { data: { user, token } } });
});

app.post("/api/auth/login", async (c) => {
  const body = await parseBody(c);
  const { email, password } = body;
  if (!email || !password) return c.json({ error: "Email and password required" }, 400);
  
  const user = sqlite.prepare("SELECT id, unionId, name, email, password, avatar, role FROM users WHERE email = ?").get(email);
  if (!user || !verifyPassword(password, user.password)) return c.json({ error: "Invalid email or password" }, 401);
  
  const timestamp = Date.now();
  sqlite.prepare("UPDATE users SET lastSignInAt = ? WHERE id = ?").run(timestamp, user.id);
  
  const token = signJWT({ userId: user.id, unionId: user.unionId, email: user.email, role: user.role });
  const { password: _, ...userWithoutPassword } = user;
  return c.json({ result: { data: { user: userWithoutPassword, token } } });
});

app.post("/api/trpc/auth.me", (c) => {
  const user = getCurrentUser(c);
  if (!user) return c.json({ result: { data: null } });
  return c.json({ result: { data: { id: user.id, unionId: user.unionId, name: user.name, email: user.email, avatar: user.avatar, role: user.role } } });
});

app.post("/api/trpc/auth.logout", (c) => {
  return c.json({ result: { data: { success: true } } });
});

// ── Google OAuth ─────────────────────────────────────────────────
app.get("/api/auth/google", (c) => {
  if (!GOOGLE_CLIENT_ID) return c.json({ error: "Google OAuth not configured" }, 500);
  const state = generateState();
  const redirectUri = `${OAUTH_REDIRECT_URL}/api/auth/google/callback`;
  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id", GOOGLE_CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", "openid email profile");
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("prompt", "consent");
  return c.redirect(authUrl.toString(), 302);
});

app.get("/api/auth/google/callback", async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");
  if (!code || !verifyState(state)) return c.json({ error: "Invalid state or missing code" }, 400);
  try {
    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET,
        code, redirect_uri: `${OAUTH_REDIRECT_URL}/api/auth/google/callback`,
        grant_type: "authorization_code",
      }),
    });
    const tokenData = await tokenResponse.json();
    if (!tokenData.access_token) return c.json({ error: "Failed to get access token" }, 400);
    const userResponse = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const userData = await userResponse.json();
    if (!userData.id) return c.json({ error: "Failed to get user info" }, 400);
    const unionId = `google_${userData.id}`;
    const existing = sqlite.prepare("SELECT * FROM users WHERE unionId = ?").get(unionId);
    const timestamp = Date.now();
    if (existing) {
      sqlite.prepare("UPDATE users SET name = ?, email = ?, avatar = ?, lastSignInAt = ? WHERE id = ?")
        .run(userData.name || existing.name, userData.email || existing.email, userData.picture || existing.avatar, timestamp, existing.id);
    } else {
      sqlite.prepare("INSERT INTO users (unionId, name, email, avatar, role, createdAt, updatedAt, lastSignInAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(unionId, userData.name || userData.email, userData.email, userData.picture, "user", timestamp, timestamp, timestamp);
    }
    const user = sqlite.prepare("SELECT * FROM users WHERE unionId = ?").get(unionId);
    const token = signJWT({ userId: user.id, unionId: user.unionId, email: user.email, role: user.role });
    return c.json({ result: { data: { token, user: { id: user.id, name: user.name, email: user.email, avatar: user.avatar, role: user.role } } } });
  } catch (err) {
    console.error("Google OAuth error:", err);
    return c.json({ error: "OAuth failed", details: err.message }, 500);
  }
});

// ── GitHub OAuth ─────────────────────────────────────────────────
app.get("/api/auth/github", (c) => {
  if (!GITHUB_CLIENT_ID) return c.json({ error: "GitHub OAuth not configured" }, 500);
  const state = generateState();
  const redirectUri = `${OAUTH_REDIRECT_URL}/api/auth/github/callback`;
  const authUrl = new URL("https://github.com/login/oauth/authorize");
  authUrl.searchParams.set("client_id", GITHUB_CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("scope", "read:user user:email");
  authUrl.searchParams.set("state", state);
  return c.redirect(authUrl.toString(), 302);
});

app.get("/api/auth/github/callback", async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");
  if (!code || !verifyState(state)) return c.json({ error: "Invalid state or missing code" }, 400);
  try {
    const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ client_id: GITHUB_CLIENT_ID, client_secret: GITHUB_CLIENT_SECRET, code, redirect_uri: `${OAUTH_REDIRECT_URL}/api/auth/github/callback` }),
    });
    const tokenData = await tokenResponse.json();
    if (!tokenData.access_token) return c.json({ error: "Failed to get access token" }, 400);
    const userResponse = await fetch("https://api.github.com/user", {
      headers: { Authorization: `Bearer ${tokenData.access_token}`, "User-Agent": "OMNIS-App" },
    });
    const userData = await userResponse.json();
    if (!userData.id) return c.json({ error: "Failed to get user info" }, 400);
    let email = userData.email;
    if (!email) {
      const emailResponse = await fetch("https://api.github.com/user/emails", {
        headers: { Authorization: `Bearer ${tokenData.access_token}`, "User-Agent": "OMNIS-App" },
      });
      const emails = await emailResponse.json();
      if (Array.isArray(emails) && emails.length > 0) {
        const primary = emails.find(e => e.primary) || emails[0];
        email = primary.email;
      }
    }
    const unionId = `github_${userData.id}`;
    const existing = sqlite.prepare("SELECT * FROM users WHERE unionId = ?").get(unionId);
    const timestamp = Date.now();
    if (existing) {
      sqlite.prepare("UPDATE users SET name = ?, email = ?, avatar = ?, lastSignInAt = ? WHERE id = ?")
        .run(userData.name || userData.login || existing.name, email || existing.email, userData.avatar_url || existing.avatar, timestamp, existing.id);
    } else {
      sqlite.prepare("INSERT INTO users (unionId, name, email, avatar, role, createdAt, updatedAt, lastSignInAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(unionId, userData.name || userData.login, email, userData.avatar_url, "user", timestamp, timestamp, timestamp);
    }
    const user = sqlite.prepare("SELECT * FROM users WHERE unionId = ?").get(unionId);
    const token = signJWT({ userId: user.id, unionId: user.unionId, email: user.email, role: user.role });
    return c.json({ result: { data: { token, user: { id: user.id, name: user.name, email: user.email, avatar: user.avatar, role: user.role } } } });
  } catch (err) {
    console.error("GitHub OAuth error:", err);
    return c.json({ error: "OAuth failed", details: err.message }, 500);
  }
});

// ── Dashboard ──────────────────────────────────────────────────
app.post("/api/trpc/dashboard.stats", (c) => {
  const leads = sqlite.prepare("SELECT COUNT(*) as c FROM business_leads").get();
  const clients = sqlite.prepare("SELECT COUNT(*) as c FROM clients WHERE client_status = 'active'").get();
  const payments = sqlite.prepare("SELECT COALESCE(SUM(amount), 0) as c FROM payments WHERE status = 'completed'").get();
  const mrr = sqlite.prepare("SELECT COALESCE(SUM(monthly_recurring_revenue), 0) as c FROM contracts WHERE contract_status = 'signed'").get();
  const pendingContracts = sqlite.prepare("SELECT COUNT(*) as c FROM contracts WHERE contract_status = 'pending_approval'").get();
  const stagingProjects = sqlite.prepare("SELECT COUNT(*) as c FROM website_projects WHERE status = 'staging'").get();
  return c.json({ result: { data: { leads: { total: leads?.c || 0 }, clients: { active: clients?.c || 0 }, revenue: { total: String(payments?.c || 0), mrr: String(mrr?.c || 0) }, pendingContracts: pendingContracts?.c || 0, stagingProjects: stagingProjects?.c || 0, proposals: [], contracts: [], projects: [] } } });
});

app.post("/api/trpc/dashboard.recentActivity", async (c) => {
  const body = await parseBody(c);
  const limit = body?.limit || 10;
  const recentLeads = sqlite.prepare("SELECT * FROM business_leads ORDER BY created_at DESC LIMIT ?").all(limit);
  const recentClients = sqlite.prepare("SELECT * FROM clients ORDER BY created_at DESC LIMIT ?").all(limit);
  const recentPayments = sqlite.prepare("SELECT * FROM payments ORDER BY created_at DESC LIMIT ?").all(limit);
  const recentLogs = sqlite.prepare("SELECT * FROM agent_logs ORDER BY created_at DESC LIMIT ?").all(limit);
  const recentWorkflows = sqlite.prepare("SELECT * FROM workflow_runs ORDER BY started_at DESC LIMIT ?").all(limit);
  return c.json({ result: { data: { recentLeads, recentClients, recentPayments, recentLogs, recentWorkflows } } });
});

app.post("/api/trpc/dashboard.pipeline", (c) => {
  const leadsByStatus = sqlite.prepare("SELECT status, COUNT(*) as count FROM business_leads GROUP BY status").all();
  const clientsByStatus = sqlite.prepare("SELECT client_status as status, COUNT(*) as count FROM clients GROUP BY client_status").all();
  const paymentsByType = sqlite.prepare("SELECT payment_type as type, COUNT(*) as count, COALESCE(SUM(amount), 0) as total FROM payments WHERE status = 'completed' GROUP BY payment_type").all();
  const agentByType = sqlite.prepare("SELECT agent_type as type, COUNT(*) as count FROM agent_logs GROUP BY agent_type").all();
  const contractStatus = sqlite.prepare("SELECT contract_status as status, COUNT(*) as count FROM contracts GROUP BY contract_status").all();
  const projectStatus = sqlite.prepare("SELECT status, COUNT(*) as count FROM website_projects GROUP BY status").all();
  return c.json({ result: { data: { leadsByStatus, clientsByStatus, paymentsByType, agentActivityByType: agentByType, workflowsByType: [], contractStatus, projectStatus } } });
});

// ── Leads CRUD ───────────────────────────────────────────────
app.post("/api/trpc/lead.list", async (c) => {
  const body = await parseBody(c);
  const limit = body?.limit || 50;
  const offset = body?.offset || 0;
  const items = sqlite.prepare("SELECT * FROM business_leads ORDER BY created_at DESC LIMIT ? OFFSET ?").all(limit, offset);
  const count = sqlite.prepare("SELECT COUNT(*) as c FROM business_leads").get();
  return c.json({ result: { data: { items, total: count?.c || 0, limit, offset } } });
});

app.post("/api/trpc/lead.getById", async (c) => {
  const body = await parseBody(c);
  const id = body?.id;
  if (!id) return c.json({ result: { data: null } });
  const item = sqlite.prepare("SELECT * FROM business_leads WHERE id = ?").get(id);
  return c.json({ result: { data: item || null } });
});

app.post("/api/trpc/lead.create", async (c) => {
  const body = await parseBody(c);
  const now = Date.now();
  const result = sqlite.prepare(
    "INSERT INTO business_leads (business_name, category, address, phone, email, has_website, discovery_source, status, assigned_agent, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(
    body.business_name || "", body.category || null, body.address || null, body.phone || null,
    body.email || null, body.has_website ? 1 : 0, body.discovery_source || null, body.status || "new",
    body.assigned_agent || null, body.notes || null, now, now
  );
  const item = sqlite.prepare("SELECT * FROM business_leads WHERE id = ?").get(result.lastInsertRowid);
  return c.json({ result: { data: item } });
});

app.post("/api/trpc/lead.update", async (c) => {
  const body = await parseBody(c);
  const id = body?.id;
  if (!id) return c.json({ error: { message: "ID required" } }, 400);
  const existing = sqlite.prepare("SELECT * FROM business_leads WHERE id = ?").get(id);
  if (!existing) return c.json({ error: { message: "Lead not found" } }, 404);
  const now = Date.now();
  sqlite.prepare(
    "UPDATE business_leads SET business_name = ?, category = ?, address = ?, phone = ?, email = ?, has_website = ?, discovery_source = ?, status = ?, assigned_agent = ?, notes = ?, updated_at = ? WHERE id = ?"
  ).run(
    body.business_name ?? existing.business_name, body.category ?? existing.category,
    body.address ?? existing.address, body.phone ?? existing.phone, body.email ?? existing.email,
    body.has_website !== undefined ? (body.has_website ? 1 : 0) : existing.has_website,
    body.discovery_source ?? existing.discovery_source, body.status ?? existing.status,
    body.assigned_agent ?? existing.assigned_agent, body.notes ?? existing.notes, now, id
  );
  const item = sqlite.prepare("SELECT * FROM business_leads WHERE id = ?").get(id);
  return c.json({ result: { data: item } });
});

app.post("/api/trpc/lead.delete", async (c) => {
  const body = await parseBody(c);
  const id = body?.id;
  if (!id) return c.json({ error: { message: "ID required" } }, 400);
  sqlite.prepare("DELETE FROM business_leads WHERE id = ?").run(id);
  return c.json({ result: { data: { success: true } } });
});

app.post("/api/trpc/lead.stats", (c) => {
  const result = sqlite.prepare("SELECT status, COUNT(*) as count FROM business_leads GROUP BY status").all();
  return c.json({ result: { data: result } });
});

// ── Clients CRUD ─────────────────────────────────────────────
app.post("/api/trpc/client.list", async (c) => {
  const body = await parseBody(c);
  const limit = body?.limit || 50;
  const offset = body?.offset || 0;
  const items = sqlite.prepare("SELECT * FROM clients ORDER BY created_at DESC LIMIT ? OFFSET ?").all(limit, offset);
  const count = sqlite.prepare("SELECT COUNT(*) as c FROM clients").get();
  return c.json({ result: { data: { items, total: count?.c || 0, limit, offset } } });
});

app.post("/api/trpc/client.getById", async (c) => {
  const body = await parseBody(c);
  const id = body?.id;
  if (!id) return c.json({ result: { data: null } });
  const item = sqlite.prepare("SELECT * FROM clients WHERE id = ?").get(id);
  return c.json({ result: { data: item || null } });
});

app.post("/api/trpc/client.create", async (c) => {
  const body = await parseBody(c);
  const now = Date.now();
  const result = sqlite.prepare(
    "INSERT INTO clients (lead_id, contract_id, client_status, website_url, last_payment_at, next_payment_at, total_revenue, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(body.lead_id || 0, body.contract_id || 0, body.client_status || "active", body.website_url || null,
    body.last_payment_at || null, body.next_payment_at || null, body.total_revenue || 0, now);
  const item = sqlite.prepare("SELECT * FROM clients WHERE id = ?").get(result.lastInsertRowid);
  return c.json({ result: { data: item } });
});

app.post("/api/trpc/client.update", async (c) => {
  const body = await parseBody(c);
  const id = body?.id;
  if (!id) return c.json({ error: { message: "ID required" } }, 400);
  const existing = sqlite.prepare("SELECT * FROM clients WHERE id = ?").get(id);
  if (!existing) return c.json({ error: { message: "Client not found" } }, 404);
  sqlite.prepare(
    "UPDATE clients SET lead_id = ?, contract_id = ?, client_status = ?, website_url = ?, last_payment_at = ?, next_payment_at = ?, total_revenue = ? WHERE id = ?"
  ).run(body.lead_id ?? existing.lead_id, body.contract_id ?? existing.contract_id, body.client_status ?? existing.client_status,
    body.website_url ?? existing.website_url, body.last_payment_at ?? existing.last_payment_at, body.next_payment_at ?? existing.next_payment_at,
    body.total_revenue ?? existing.total_revenue, id);
  const item = sqlite.prepare("SELECT * FROM clients WHERE id = ?").get(id);
  return c.json({ result: { data: item } });
});

app.post("/api/trpc/client.delete", async (c) => {
  const body = await parseBody(c);
  const id = body?.id;
  if (!id) return c.json({ error: { message: "ID required" } }, 400);
  sqlite.prepare("DELETE FROM clients WHERE id = ?").run(id);
  return c.json({ result: { data: { success: true } } });
});

// ── Proposals CRUD ────────────────────────────────────────────
app.post("/api/trpc/proposal.list", async (c) => {
  const body = await parseBody(c);
  const limit = body?.limit || 50;
  const offset = body?.offset || 0;
  const items = sqlite.prepare("SELECT * FROM proposals ORDER BY created_at DESC LIMIT ? OFFSET ?").all(limit, offset);
  const count = sqlite.prepare("SELECT COUNT(*) as c FROM proposals").get();
  return c.json({ result: { data: { items, total: count?.c || 0, limit, offset } } });
});

app.post("/api/trpc/proposal.getById", async (c) => {
  const body = await parseBody(c);
  const id = body?.id;
  if (!id) return c.json({ result: { data: null } });
  const item = sqlite.prepare("SELECT * FROM proposals WHERE id = ?").get(id);
  return c.json({ result: { data: item || null } });
});

app.post("/api/trpc/proposal.create", async (c) => {
  const body = await parseBody(c);
  const now = Date.now();
  const result = sqlite.prepare(
    "INSERT INTO proposals (lead_id, project_id, proposal_type, monthly_fee, setup_fee, total_price, included_services, status, sent_at, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(body.lead_id || 0, body.project_id || null, body.proposal_type || null, body.monthly_fee || 0, body.setup_fee || 0,
    body.total_price || 0, body.included_services || null, body.status || "draft", body.sent_at || null, body.expires_at || null, now);
  const item = sqlite.prepare("SELECT * FROM proposals WHERE id = ?").get(result.lastInsertRowid);
  return c.json({ result: { data: item } });
});

app.post("/api/trpc/proposal.update", async (c) => {
  const body = await parseBody(c);
  const id = body?.id;
  if (!id) return c.json({ error: { message: "ID required" } }, 400);
  const existing = sqlite.prepare("SELECT * FROM proposals WHERE id = ?").get(id);
  if (!existing) return c.json({ error: { message: "Proposal not found" } }, 404);
  sqlite.prepare(
    "UPDATE proposals SET lead_id = ?, project_id = ?, proposal_type = ?, monthly_fee = ?, setup_fee = ?, total_price = ?, included_services = ?, status = ?, sent_at = ?, expires_at = ? WHERE id = ?"
  ).run(body.lead_id ?? existing.lead_id, body.project_id ?? existing.project_id, body.proposal_type ?? existing.proposal_type,
    body.monthly_fee ?? existing.monthly_fee, body.setup_fee ?? existing.setup_fee, body.total_price ?? existing.total_price,
    body.included_services ?? existing.included_services, body.status ?? existing.status, body.sent_at ?? existing.sent_at,
    body.expires_at ?? existing.expires_at, id);
  const item = sqlite.prepare("SELECT * FROM proposals WHERE id = ?").get(id);
  return c.json({ result: { data: item } });
});

app.post("/api/trpc/proposal.delete", async (c) => {
  const body = await parseBody(c);
  const id = body?.id;
  if (!id) return c.json({ error: { message: "ID required" } }, 400);
  sqlite.prepare("DELETE FROM proposals WHERE id = ?").run(id);
  return c.json({ result: { data: { success: true } } });
});

// ── Contracts CRUD ──────────────────────────────────────────────
app.post("/api/trpc/contract.list", async (c) => {
  const body = await parseBody(c);
  const limit = body?.limit || 50;
  const offset = body?.offset || 0;
  const items = sqlite.prepare("SELECT * FROM contracts ORDER BY created_at DESC LIMIT ? OFFSET ?").all(limit, offset);
  const count = sqlite.prepare("SELECT COUNT(*) as c FROM contracts").get();
  return c.json({ result: { data: { items, total: count?.c || 0, limit, offset } } });
});

app.post("/api/trpc/contract.getById", async (c) => {
  const body = await parseBody(c);
  const id = body?.id;
  if (!id) return c.json({ result: { data: null } });
  const item = sqlite.prepare("SELECT * FROM contracts WHERE id = ?").get(id);
  return c.json({ result: { data: item || null } });
});

app.post("/api/trpc/contract.create", async (c) => {
  const body = await parseBody(c);
  const now = Date.now();
  const result = sqlite.prepare(
    "INSERT INTO contracts (proposal_id, lead_id, contract_type, contract_status, contract_content, signature_url, signed_at, expires_at, monthly_recurring_revenue, approved_by, approved_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(body.proposal_id || 0, body.lead_id || 0, body.contract_type || null, body.contract_status || "draft",
    body.contract_content || null, body.signature_url || null, body.signed_at || null, body.expires_at || null, body.monthly_recurring_revenue || 0, body.approved_by || null, body.approved_at || null, now);
  const item = sqlite.prepare("SELECT * FROM contracts WHERE id = ?").get(result.lastInsertRowid);
  return c.json({ result: { data: item } });
});

app.post("/api/trpc/contract.update", async (c) => {
  const body = await parseBody(c);
  const id = body?.id;
  if (!id) return c.json({ error: { message: "ID required" } }, 400);
  const existing = sqlite.prepare("SELECT * FROM contracts WHERE id = ?").get(id);
  if (!existing) return c.json({ error: { message: "Contract not found" } }, 404);
  sqlite.prepare(
    "UPDATE contracts SET proposal_id = ?, lead_id = ?, contract_type = ?, contract_status = ?, contract_content = ?, signature_url = ?, signed_at = ?, expires_at = ?, monthly_recurring_revenue = ?, approved_by = ?, approved_at = ? WHERE id = ?"
  ).run(body.proposal_id ?? existing.proposal_id, body.lead_id ?? existing.lead_id, body.contract_type ?? existing.contract_type,
    body.contract_status ?? existing.contract_status, body.contract_content ?? existing.contract_content, body.signature_url ?? existing.signature_url,
    body.signed_at ?? existing.signed_at, body.expires_at ?? existing.expires_at, body.monthly_recurring_revenue ?? existing.monthly_recurring_revenue,
    body.approved_by ?? existing.approved_by, body.approved_at ?? existing.approved_at, id);
  const item = sqlite.prepare("SELECT * FROM contracts WHERE id = ?").get(id);
  return c.json({ result: { data: item } });
});

app.post("/api/trpc/contract.approve", async (c) => {
  const body = await parseBody(c);
  const id = body?.id;
  if (!id) return c.json({ error: { message: "ID required" } }, 400);
  const existing = sqlite.prepare("SELECT * FROM contracts WHERE id = ?").get(id);
  if (!existing) return c.json({ error: { message: "Contract not found" } }, 404);
  const now = Date.now();
  const user = getCurrentUser(c);
  const userId = user?.id || null;
  sqlite.prepare("UPDATE contracts SET contract_status = ?, approved_by = ?, approved_at = ? WHERE id = ?")
    .run("approved", userId, now, id);
  sqlite.prepare("INSERT INTO contract_approvals (contract_id, approver_id, action, notes, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(id, userId, "approved", body.notes || null, now);
  const item = sqlite.prepare("SELECT * FROM contracts WHERE id = ?").get(id);
  return c.json({ result: { data: item } });
});

app.post("/api/trpc/contract.reject", async (c) => {
  const body = await parseBody(c);
  const id = body?.id;
  if (!id) return c.json({ error: { message: "ID required" } }, 400);
  const existing = sqlite.prepare("SELECT * FROM contracts WHERE id = ?").get(id);
  if (!existing) return c.json({ error: { message: "Contract not found" } }, 404);
  const now = Date.now();
  const user = getCurrentUser(c);
  const userId = user?.id || null;
  sqlite.prepare("UPDATE contracts SET contract_status = ? WHERE id = ?").run("rejected", id);
  sqlite.prepare("INSERT INTO contract_approvals (contract_id, approver_id, action, notes, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(id, userId, "rejected", body.notes || null, now);
  const item = sqlite.prepare("SELECT * FROM contracts WHERE id = ?").get(id);
  return c.json({ result: { data: item } });
});

app.post("/api/trpc/contract.send", async (c) => {
  const body = await parseBody(c);
  const id = body?.id;
  if (!id) return c.json({ error: { message: "ID required" } }, 400);
  const existing = sqlite.prepare("SELECT * FROM contracts WHERE id = ?").get(id);
  if (!existing) return c.json({ error: { message: "Contract not found" } }, 404);
  if (existing.contract_status !== "approved") return c.json({ error: { message: "Contract must be approved before sending" } }, 400);
  const now = Date.now();
  sqlite.prepare("UPDATE contracts SET contract_status = ?, sent_at = ? WHERE id = ?").run("sent", now, id);
  const item = sqlite.prepare("SELECT * FROM contracts WHERE id = ?").get(id);
  return c.json({ result: { data: item } });
});

app.post("/api/trpc/contract.delete", async (c) => {
  const body = await parseBody(c);
  const id = body?.id;
  if (!id) return c.json({ error: { message: "ID required" } }, 400);
  sqlite.prepare("DELETE FROM contracts WHERE id = ?").run(id);
  return c.json({ result: { data: { success: true } } });
});

// ── Website Projects CRUD ──────────────────────────────────────
app.post("/api/trpc/website_project.list", async (c) => {
  const body = await parseBody(c);
  const limit = body?.limit || 20;
  const offset = body?.offset || 0;
  const items = sqlite.prepare("SELECT * FROM website_projects ORDER BY created_at DESC LIMIT ? OFFSET ?").all(limit, offset);
  const count = sqlite.prepare("SELECT COUNT(*) as c FROM website_projects").get();
  return c.json({ result: { data: { items, total: count?.c || 0, limit, offset } } });
});

app.post("/api/trpc/website_project.getById", async (c) => {
  const body = await parseBody(c);
  const id = body?.id;
  if (!id) return c.json({ result: { data: null } });
  const item = sqlite.prepare("SELECT * FROM website_projects WHERE id = ?").get(id);
  return c.json({ result: { data: item || null } });
});

app.post("/api/trpc/website_project.create", async (c) => {
  const body = await parseBody(c);
  const now = Date.now();
  const result = sqlite.prepare(
    "INSERT INTO website_projects (lead_id, project_name, status, design_url, template_used, pages_built, total_pages, build_progress, preview_url, staging_url, approved_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(body.lead_id || 0, body.project_name || null, body.status || "draft", body.design_url || null, body.template_used || null,
    body.pages_built || 0, body.total_pages || 5, body.build_progress || 0, body.preview_url || null, body.staging_url || null, body.approved_at || null, now, now);
  const item = sqlite.prepare("SELECT * FROM website_projects WHERE id = ?").get(result.lastInsertRowid);
  return c.json({ result: { data: item } });
});

app.post("/api/trpc/website_project.update", async (c) => {
  const body = await parseBody(c);
  const id = body?.id;
  if (!id) return c.json({ error: { message: "ID required" } }, 400);
  const existing = sqlite.prepare("SELECT * FROM website_projects WHERE id = ?").get(id);
  if (!existing) return c.json({ error: { message: "Project not found" } }, 404);
  const now = Date.now();
  sqlite.prepare(
    "UPDATE website_projects SET lead_id = ?, project_name = ?, status = ?, design_url = ?, template_used = ?, pages_built = ?, total_pages = ?, build_progress = ?, preview_url = ?, staging_url = ?, approved_at = ?, updated_at = ? WHERE id = ?"
  ).run(body.lead_id ?? existing.lead_id, body.project_name ?? existing.project_name, body.status ?? existing.status,
    body.design_url ?? existing.design_url, body.template_used ?? existing.template_used, body.pages_built ?? existing.pages_built,
    body.total_pages ?? existing.total_pages, body.build_progress ?? existing.build_progress, body.preview_url ?? existing.preview_url,
    body.staging_url ?? existing.staging_url, body.approved_at ?? existing.approved_at, now, id);
  const item = sqlite.prepare("SELECT * FROM website_projects WHERE id = ?").get(id);
  return c.json({ result: { data: item } });
});

app.post("/api/trpc/website_project.approve", async (c) => {
  const body = await parseBody(c);
  const id = body?.id;
  if (!id) return c.json({ error: { message: "ID required" } }, 400);
  const existing = sqlite.prepare("SELECT * FROM website_projects WHERE id = ?").get(id);
  if (!existing) return c.json({ error: { message: "Project not found" } }, 404);
  const now = Date.now();
  sqlite.prepare("UPDATE website_projects SET status = ?, approved_at = ? WHERE id = ?")
    .run("approved", now, id);
  const item = sqlite.prepare("SELECT * FROM website_projects WHERE id = ?").get(id);
  return c.json({ result: { data: item } });
});

app.post("/api/trpc/website_project.deploy", async (c) => {
  const body = await parseBody(c);
  const id = body?.id;
  if (!id) return c.json({ error: { message: "ID required" } }, 400);
  const existing = sqlite.prepare("SELECT * FROM website_projects WHERE id = ?").get(id);
  if (!existing) return c.json({ error: { message: "Project not found" } }, 404);
  if (existing.status !== "approved") return c.json({ error: { message: "Project must be approved before deployment" } }, 400);
  sqlite.prepare("UPDATE website_projects SET status = ? WHERE id = ?").run("deployed", id);
  const item = sqlite.prepare("SELECT * FROM website_projects WHERE id = ?").get(id);
  return c.json({ result: { data: item } });
});

app.post("/api/trpc/website_project.delete", async (c) => {
  const body = await parseBody(c);
  const id = body?.id;
  if (!id) return c.json({ error: { message: "ID required" } }, 400);
  sqlite.prepare("DELETE FROM website_projects WHERE id = ?").run(id);
  return c.json({ result: { data: { success: true } } });
});

// ── Payments CRUD ─────────────────────────────────────────────
app.post("/api/trpc/payment.list", async (c) => {
  const body = await parseBody(c);
  const limit = body?.limit || 50;
  const offset = body?.offset || 0;
  const items = sqlite.prepare(`SELECT p.*, c.lead_id as client_lead_id, c.website_url as client_website, c.client_status FROM payments p LEFT JOIN clients c ON p.client_id = c.id ORDER BY p.created_at DESC LIMIT ? OFFSET ?`).all(limit, offset);
  const count = sqlite.prepare("SELECT COUNT(*) as c FROM payments").get();
  const byClient = sqlite.prepare(`SELECT c.id as client_id, c.website_url, SUM(p.amount) as total FROM payments p JOIN clients c ON p.client_id = c.id WHERE p.status = 'completed' GROUP BY c.id`).all();
  return c.json({ result: { data: { items, total: count?.c || 0, limit, offset, byClient } } });
});

app.post("/api/trpc/payment.getById", async (c) => {
  const body = await parseBody(c);
  const id = body?.id;
  if (!id) return c.json({ result: { data: null } });
  const item = sqlite.prepare("SELECT * FROM payments WHERE id = ?").get(id);
  return c.json({ result: { data: item || null } });
});

app.post("/api/trpc/payment.create", async (c) => {
  const body = await parseBody(c);
  const now = Date.now();
  const result = sqlite.prepare(
    "INSERT INTO payments (client_id, amount, payment_type, status, paid_at, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(body.client_id || 0, body.amount || 0, body.payment_type || null, body.status || "pending", body.paid_at || null, now);
  const item = sqlite.prepare("SELECT * FROM payments WHERE id = ?").get(result.lastInsertRowid);
  return c.json({ result: { data: item } });
});

app.post("/api/trpc/payment.update", async (c) => {
  const body = await parseBody(c);
  const id = body?.id;
  if (!id) return c.json({ error: { message: "ID required" } }, 400);
  const existing = sqlite.prepare("SELECT * FROM payments WHERE id = ?").get(id);
  if (!existing) return c.json({ error: { message: "Payment not found" } }, 404);
  sqlite.prepare(
    "UPDATE payments SET client_id = ?, amount = ?, payment_type = ?, status = ?, paid_at = ? WHERE id = ?"
  ).run(body.client_id ?? existing.client_id, body.amount ?? existing.amount, body.payment_type ?? existing.payment_type,
    body.status ?? existing.status, body.paid_at ?? existing.paid_at, id);
  const item = sqlite.prepare("SELECT * FROM payments WHERE id = ?").get(id);
  return c.json({ result: { data: item } });
});

app.post("/api/trpc/payment.delete", async (c) => {
  const body = await parseBody(c);
  const id = body?.id;
  if (!id) return c.json({ error: { message: "ID required" } }, 400);
  sqlite.prepare("DELETE FROM payments WHERE id = ?").run(id);
  return c.json({ result: { data: { success: true } } });
});

// ── Agent Logs ───────────────────────────────────────────────
app.post("/api/trpc/agentLog.list", async (c) => {
  const body = await parseBody(c);
  const limit = body?.limit || 50;
  const offset = body?.offset || 0;
  const items = sqlite.prepare("SELECT * FROM agent_logs ORDER BY created_at DESC LIMIT ? OFFSET ?").all(limit, offset);
  return c.json({ result: { data: { items } } });
});

app.post("/api/trpc/agentLog.create", async (c) => {
  const body = await parseBody(c);
  const now = Date.now();
  const result = sqlite.prepare(
    "INSERT INTO agent_logs (agent_name, agent_type, action, target_lead_id, status, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(body.agent_name || null, body.agent_type || null, body.action || null, body.target_lead_id || null,
    body.status || null, body.metadata ? JSON.stringify(body.metadata) : null, now);
  const item = sqlite.prepare("SELECT * FROM agent_logs WHERE id = ?").get(result.lastInsertRowid);
  return c.json({ result: { data: item } });
});

// ── Workflow Runs ──────────────────────────────────────────────
app.post("/api/trpc/workflow.list", async (c) => {
  const body = await parseBody(c);
  const limit = body?.limit || 50;
  const offset = body?.offset || 0;
  const items = sqlite.prepare("SELECT * FROM workflow_runs ORDER BY started_at DESC LIMIT ? OFFSET ?").all(limit, offset);
  const count = sqlite.prepare("SELECT COUNT(*) as c FROM workflow_runs").get();
  return c.json({ result: { data: { items, total: count?.c || 0, limit, offset } } });
});

app.post("/api/trpc/workflow.create", async (c) => {
  const body = await parseBody(c);
  const now = Date.now();
  const result = sqlite.prepare(
    "INSERT INTO workflow_runs (workflow_name, workflow_type, status, steps_completed, total_steps, started_at, completed_at, error_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(body.workflow_name || null, body.workflow_type || null, body.status || "pending", body.steps_completed || 0,
    body.total_steps || 0, now, body.completed_at || null, body.error_message || null);
  const item = sqlite.prepare("SELECT * FROM workflow_runs WHERE id = ?").get(result.lastInsertRowid);
  return c.json({ result: { data: item } });
});

app.post("/api/trpc/workflow.update", async (c) => {
  const body = await parseBody(c);
  const id = body?.id;
  if (!id) return c.json({ error: { message: "ID required" } }, 400);
  const existing = sqlite.prepare("SELECT * FROM workflow_runs WHERE id = ?").get(id);
  if (!existing) return c.json({ error: { message: "Workflow not found" } }, 404);
  sqlite.prepare(
    "UPDATE workflow_runs SET workflow_name = ?, workflow_type = ?, status = ?, steps_completed = ?, total_steps = ?, completed_at = ?, error_message = ? WHERE id = ?"
  ).run(body.workflow_name ?? existing.workflow_name, body.workflow_type ?? existing.workflow_type, body.status ?? existing.status,
    body.steps_completed ?? existing.steps_completed, body.total_steps ?? existing.total_steps, body.completed_at ?? existing.completed_at,
    body.error_message ?? existing.error_message, id);
  const item = sqlite.prepare("SELECT * FROM workflow_runs WHERE id = ?").get(id);
  return c.json({ result: { data: item } });
});

// ── Users ──────────────────────────────────────────────────────
app.post("/api/trpc/user.list", async (c) => {
  const items = sqlite.prepare("SELECT id, unionId, name, email, avatar, role, createdAt, updatedAt, lastSignInAt FROM users ORDER BY createdAt DESC").all();
  return c.json({ result: { data: { items } } });
});

app.post("/api/trpc/user.create", async (c) => {
  const body = await parseBody(c);
  const now = Date.now();
  const result = sqlite.prepare(
    "INSERT INTO users (unionId, name, email, password, avatar, role, createdAt, updatedAt, lastSignInAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(body.unionId || "", body.name || null, body.email || null, body.password ? hashPassword(body.password) : null,
    body.avatar || null, body.role || "user", now, now, now);
  const item = sqlite.prepare("SELECT id, unionId, name, email, avatar, role, createdAt, updatedAt, lastSignInAt FROM users WHERE id = ?").get(result.lastInsertRowid);
  return c.json({ result: { data: item } });
});

app.post("/api/trpc/user.update", async (c) => {
  const body = await parseBody(c);
  const id = body?.id;
  if (!id) return c.json({ error: { message: "ID required" } }, 400);
  const existing = sqlite.prepare("SELECT * FROM users WHERE id = ?").get(id);
  if (!existing) return c.json({ error: { message: "User not found" } }, 404);
  const now = Date.now();
  sqlite.prepare(
    "UPDATE users SET unionId = ?, name = ?, email = ?, avatar = ?, role = ?, updatedAt = ? WHERE id = ?"
  ).run(body.unionId ?? existing.unionId, body.name ?? existing.name, body.email ?? existing.email,
    body.avatar ?? existing.avatar, body.role ?? existing.role, now, id);
  const item = sqlite.prepare("SELECT id, unionId, name, email, avatar, role, createdAt, updatedAt, lastSignInAt FROM users WHERE id = ?").get(id);
  return c.json({ result: { data: item } });
});

app.post("/api/trpc/user.delete", async (c) => {
  const body = await parseBody(c);
  const id = body?.id;
  if (!id) return c.json({ error: { message: "ID required" } }, 400);
  sqlite.prepare("DELETE FROM users WHERE id = ?").run(id);
  return c.json({ result: { data: { success: true } } });
});

// ── SPA fallback ───────────────────────────────────────────────
const publicPath = path.join(__dirname, "public");
if (fs.existsSync(publicPath)) {
  app.use("*", serveStatic({ root: "./public" }));
  app.notFound((c) => {
    const accept = c.req.header("accept") ?? "";
    if (!accept.includes("text/html")) return c.json({ error: "Not Found" }, 404);
    const indexPath = path.join(publicPath, "index.html");
    if (fs.existsSync(indexPath)) return c.html(fs.readFileSync(indexPath, "utf-8"));
    return c.json({ error: "Not Found" }, 404);
  });
} else {
  app.all("*", (c) => c.json({ error: "Not Found" }, 404));
}

const port = parseInt(process.env.PORT || "3000");
serve({ fetch: app.fetch, port }, () => {
  console.log(`OMNIS API running on port ${port}`);
});
