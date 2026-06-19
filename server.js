import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import "dotenv/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Initialize SQLite ──────────────────────────────────────────
const dbPath = path.join(__dirname, "omnis.db");
const sqlite = new Database(dbPath);
sqlite.exec("PRAGMA journal_mode = WAL;");
sqlite.exec("PRAGMA foreign_keys = ON;");

// Create tables
sqlite.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  unionId TEXT NOT NULL UNIQUE,
  name TEXT,
  email TEXT,
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

// ── Seed data ────────────────────────────────────────────────
const now = Date.now();
const day = 86400000;

const leadCount = sqlite.prepare("SELECT COUNT(*) as c FROM business_leads").get();
if (leadCount.c === 0) {
  const leads = [
    ["Sunrise Bakery", "Food & Beverage", "123 Main St, Austin, TX", "(512) 555-0101", "hello@sunrisebakery.com", 0, "google_maps", "contacted", "Agent Alpha", "No website. Only Facebook page.", now-30*day, now-2*day],
    ["Downtown Dental Care", "Healthcare", "456 Oak Ave, Portland, OR", "(503) 555-0202", "info@downtowndental.com", 0, "yelp_scraper", "qualified", "Agent Beta", "Established practice, 4.8 stars on Yelp.", now-45*day, now-5*day],
    ["Elite Fitness Studio", "Fitness & Wellness", "789 Gym Blvd, Miami, FL", "(305) 555-0303", "contact@elitefitness.com", 0, "facebook_ads", "new", "Agent Gamma", "Instagram only. No booking system.", now-7*day, now-7*day],
    ["River Valley Plumbing", "Home Services", "321 River Rd, Denver, CO", "(720) 555-0404", "service@rivervalleyplumbing.com", 0, "google_maps", "negotiating", "Agent Delta", "Family business 15 years.", now-60*day, now-1*day],
    ["Parkside Café & Books", "Retail & Hospitality", "654 Park Ln, Seattle, WA", "(206) 555-0505", "hello@parksidecafe.com", 0, "yelp_scraper", "qualified", "Agent Alpha", "Unique concept. 4.9 stars.", now-14*day, now-3*day],
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
    [1, 6, 6, "full_ownership", "signed", "Full ownership $2,499", null, now-105*day, now+365*day, 0, now-105*day],
    [2, 7, 7, "subscription", "signed", "Annual subscription $149/mo", null, now-135*day, now+365*day, 149, now-135*day],
  ];
  const insertContract = sqlite.prepare("INSERT INTO contracts (proposal_id, lead_id, contract_type, contract_status, contract_content, signature_url, signed_at, expires_at, monthly_recurring_revenue, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  for (const c of contracts) insertContract.run(...c);

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

  const users = [["demo_user", "CEO", "ceo@omnis.systems", null, "admin", now-200*day, now-1*day, now-1*day]];
  const insertUser = sqlite.prepare("INSERT INTO users (unionId, name, email, avatar, role, createdAt, updatedAt, lastSignInAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  for (const u of users) insertUser.run(...u);
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
  if (contentLength > 50 * 1024 * 1024) {
    return c.json({ error: "Payload too large" }, 413);
  }
  await next();
});

// Health check
app.get("/api/ping", (c) => c.json({ ok: true, ts: Date.now() }));
app.get("/api/trpc/ping", (c) => c.json({ ok: true, ts: Date.now() }));

// Auth
app.get("/api/trpc/auth.me", (c) => {
  const user = sqlite.prepare("SELECT * FROM users WHERE unionId = ?").get("demo_user");
  return c.json({ result: { data: user || { id: 1, unionId: "demo_user", name: "CEO", email: "ceo@omnis.systems", role: "admin" } } });
});

app.post("/api/trpc/auth.logout", (c) => c.json({ result: { data: { success: true } } }));

// Dashboard stats
app.post("/api/trpc/dashboard.stats", (c) => {
  const leads = sqlite.prepare("SELECT COUNT(*) as c FROM business_leads").get();
  const clients = sqlite.prepare("SELECT COUNT(*) as c FROM clients WHERE client_status = 'active'").get();
  const payments = sqlite.prepare("SELECT COALESCE(SUM(amount), 0) as c FROM payments WHERE status = 'completed'").get();
  const mrr = sqlite.prepare("SELECT COALESCE(SUM(monthly_recurring_revenue), 0) as c FROM contracts WHERE contract_status = 'signed'").get();
  return c.json({ result: { data: { leads: { total: leads?.c || 0 }, clients: { active: clients?.c || 0 }, revenue: { total: String(payments?.c || 0), mrr: String(mrr?.c || 0) }, proposals: [], contracts: [], projects: [] } } });
});

// Recent activity
app.post("/api/trpc/dashboard.recentActivity", async (c) => {
  let body = {};
  try { body = await c.req.json(); } catch {}
  const limit = body?.json?.limit || 10;
  const recentLeads = sqlite.prepare("SELECT * FROM business_leads ORDER BY created_at DESC LIMIT ?").all(limit);
  const recentClients = sqlite.prepare("SELECT * FROM clients ORDER BY created_at DESC LIMIT ?").all(limit);
  const recentPayments = sqlite.prepare("SELECT * FROM payments ORDER BY created_at DESC LIMIT ?").all(limit);
  const recentLogs = sqlite.prepare("SELECT * FROM agent_logs ORDER BY created_at DESC LIMIT ?").all(limit);
  const recentWorkflows = sqlite.prepare("SELECT * FROM workflow_runs ORDER BY started_at DESC LIMIT ?").all(limit);
  return c.json({ result: { data: { recentLeads, recentClients, recentPayments, recentLogs, recentWorkflows } } });
});

// Pipeline
app.post("/api/trpc/dashboard.pipeline", (c) => {
  const leadsByStatus = sqlite.prepare("SELECT status, COUNT(*) as count FROM business_leads GROUP BY status").all();
  const clientsByStatus = sqlite.prepare("SELECT client_status as status, COUNT(*) as count FROM clients GROUP BY client_status").all();
  const paymentsByType = sqlite.prepare("SELECT payment_type as type, COUNT(*) as count, COALESCE(SUM(amount), 0) as total FROM payments WHERE status = 'completed' GROUP BY payment_type").all();
  const agentByType = sqlite.prepare("SELECT agent_type as type, COUNT(*) as count FROM agent_logs GROUP BY agent_type").all();
  return c.json({ result: { data: { leadsByStatus, clientsByStatus, paymentsByType, agentActivityByType: agentByType, workflowsByType: [] } } });
});

// Lead list
app.post("/api/trpc/lead.list", async (c) => {
  let body = {};
  try { body = await c.req.json(); } catch {}
  const limit = body?.json?.limit || 50;
  const offset = body?.json?.offset || 0;
  const items = sqlite.prepare("SELECT * FROM business_leads ORDER BY created_at DESC LIMIT ? OFFSET ?").all(limit, offset);
  const count = sqlite.prepare("SELECT COUNT(*) as c FROM business_leads").get();
  return c.json({ result: { data: { items, total: count?.c || 0, limit, offset } } });
});

// Lead stats
app.post("/api/trpc/lead.stats", (c) => {
  const result = sqlite.prepare("SELECT status, COUNT(*) as count FROM business_leads GROUP BY status").all();
  return c.json({ result: { data: result } });
});

// Agent logs
app.post("/api/trpc/agentLog.list", async (c) => {
  let body = {};
  try { body = await c.req.json(); } catch {}
  const limit = body?.json?.limit || 50;
  const offset = body?.json?.offset || 0;
  const items = sqlite.prepare("SELECT * FROM agent_logs ORDER BY created_at DESC LIMIT ? OFFSET ?").all(limit, offset);
  return c.json({ result: { data: { items } } });
});

// Website projects
app.post("/api/trpc/website_project.list", async (c) => {
  let body = {};
  try { body = await c.req.json(); } catch {}
  const limit = body?.json?.limit || 20;
  const offset = body?.json?.offset || 0;
  const items = sqlite.prepare("SELECT * FROM website_projects ORDER BY created_at DESC LIMIT ? OFFSET ?").all(limit, offset);
  const count = sqlite.prepare("SELECT COUNT(*) as c FROM website_projects").get();
  return c.json({ result: { data: { items, total: count?.c || 0, limit, offset } } });
});

// OAuth callback
app.get("/api/oauth/callback", (c) => {
  const code = c.req.query("code");
  if (!code) return c.text("Missing code", 400);
  return c.redirect("/dashboard", 302);
});

// SPA fallback
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
