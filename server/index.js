import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import dotenv from 'dotenv';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import morgan from 'morgan';
import Database from 'better-sqlite3';
import Joi from 'joi';
import webpush from 'web-push';
import fs from 'fs';
import http from 'http';
import https from 'https';

dotenv.config();

const app = express();
const PORT = parseInt(process.env.PORT || '8080', 10);
const HTTPS_PORT = parseInt(process.env.HTTPS_PORT || '8443', 10);
const HTTPS_CERT_PATH = process.env.HTTPS_CERT_PATH || '';
const HTTPS_KEY_PATH = process.env.HTTPS_KEY_PATH || '';
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const ORIGIN = process.env.CORS_ORIGIN || 'http://localhost:8000';
const NODE_ENV = process.env.NODE_ENV || 'development';
const COOKIE_SECURE = NODE_ENV === 'production';
const SQLITE_FILE = process.env.SQLITE_FILE || './data.sqlite';
const VAPID_PUBLIC_KEY = process.env.WEB_PUSH_PUBLIC_KEY || '';
const VAPID_PRIVATE_KEY = process.env.WEB_PUSH_PRIVATE_KEY || '';

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(`mailto:admin@example.com`, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

// DB setup
const db = new Database(SQLITE_FILE);
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`);

db.exec(`
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  notes TEXT,
  every_days INTEGER NOT NULL,
  next_due TEXT NOT NULL,
  remind_at TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  last_completed TEXT,
  FOREIGN KEY(user_id) REFERENCES users(id)
);
`);

db.exec(`
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  endpoint TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(user_id, endpoint),
  FOREIGN KEY(user_id) REFERENCES users(id)
);
`);

db.exec(`
CREATE TABLE IF NOT EXISTS notifications_sent (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  due_key TEXT NOT NULL,
  sent_at TEXT NOT NULL,
  UNIQUE(task_id, due_key)
);
`);

// Security middleware
app.use(helmet());
app.use(morgan('dev'));
app.use(express.json({ limit: '256kb' }));
app.use(cookieParser());
const ORIGINS = (process.env.CORS_ORIGIN || ORIGIN).split(',').map(s => s.trim()).filter(Boolean);
// Unified CORS options (ensure preflight is properly handled across environments)
const corsOptions = {
  origin: function(origin, callback) {
    // Allow requests with no origin like mobile apps or curl
    if (!origin) return callback(null, true);
    if (ORIGINS.includes(origin)) return callback(null, true);
    return callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
  methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  optionsSuccessStatus: 204,
};
app.use(cors(corsOptions));
// Explicitly handle preflight requests for all routes
app.options('*', cors(corsOptions));

// Rate limiter for auth
const authLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 50,
});

function issueToken(user) {
  const token = jwt.sign({ uid: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
  return token;
}

function setAuthCookie(res, token) {
  res.cookie('tt_auth', token, {
    httpOnly: true,
    secure: COOKIE_SECURE,
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: '/',
  });
}

function clearAuthCookie(res) {
  res.clearCookie('tt_auth', { path: '/' });
}

function authMiddleware(req, res, next) {
  let token = req.cookies.tt_auth;
  if (!token) {
    const hdr = req.headers['authorization'] || req.headers['Authorization'];
    if (hdr && /^Bearer\s+/i.test(hdr)) {
      token = hdr.replace(/^Bearer\s+/i, '').trim();
    }
  }
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = { id: payload.uid, email: payload.email };
    return next();
  } catch (e) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
}

// Validation schemas
const registerSchema = Joi.object({
  email: Joi.string().email().max(255).required(),
  password: Joi.string().min(8).max(255).required(),
});
const loginSchema = registerSchema;
const taskSchema = Joi.object({
  id: Joi.string().optional(),
  title: Joi.string().min(1).max(255).required(),
  notes: Joi.string().allow('').max(1000).optional(),
  everyDays: Joi.number().integer().min(1).max(3650).required(),
  nextDue: Joi.string().regex(/^\d{4}-\d{2}-\d{2}$/).required(),
  remindAt: Joi.string().regex(/^\d{2}:\d{2}$/).required(),
  priority: Joi.boolean().optional(),
  lastCompleted: Joi.string().allow(null).optional(),
});

const subscriptionSchema = Joi.object({
  endpoint: Joi.string().uri().required(),
  expirationTime: Joi.any().allow(null),
  keys: Joi.object({ p256dh: Joi.string().required(), auth: Joi.string().required() }).required(),
});

// Auth routes
app.post('/api/auth/register', authLimiter, (req, res) => {
  const { error, value } = registerSchema.validate(req.body);
  if (error) return res.status(400).json({ error: error.message });

  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(value.email.toLowerCase());
  if (existing) return res.status(409).json({ error: 'Email already registered' });

  const hash = bcrypt.hashSync(value.password, 10);
  const info = db.prepare('INSERT INTO users (email, password_hash, created_at) VALUES (?, ?, ?)')
    .run(value.email.toLowerCase(), hash, new Date().toISOString());
  const user = { id: info.lastInsertRowid, email: value.email.toLowerCase() };
  const token = issueToken(user);
  setAuthCookie(res, token);
  res.json({ ok: true, token, user: { id: user.id, email: user.email } });
});

app.post('/api/auth/login', authLimiter, (req, res) => {
  const { error, value } = loginSchema.validate(req.body);
  if (error) return res.status(400).json({ error: error.message });

  const row = db.prepare('SELECT id, email, password_hash FROM users WHERE email = ?').get(value.email.toLowerCase());
  if (!row) return res.status(401).json({ error: 'Invalid credentials' });
  const ok = bcrypt.compareSync(value.password, row.password_hash);
  if (!ok) return res.status(401).json({ error: 'Invalid credentials' });
  const token = issueToken({ id: row.id, email: row.email });
  setAuthCookie(res, token);
  res.json({ ok: true, token, user: { id: row.id, email: row.email } });
});

app.post('/api/auth/logout', (req, res) => {
  clearAuthCookie(res);
  res.json({ ok: true });
});

app.get('/api/auth/me', authMiddleware, (req, res) => {
  res.json({ user: { id: req.user.id, email: req.user.email } });
});

// Task routes (authenticated)
app.get('/api/tasks', authMiddleware, (req, res) => {
  const rows = db.prepare('SELECT * FROM tasks WHERE user_id = ?').all(req.user.id);
  const tasks = rows.map(r => ({
    id: r.id,
    title: r.title,
    notes: r.notes || '',
    everyDays: r.every_days,
    nextDue: r.next_due,
    remindAt: r.remind_at,
    priority: !!r.priority,
    lastCompleted: r.last_completed || undefined,
  }));
  res.json({ tasks });
});

app.post('/api/tasks', authMiddleware, (req, res) => {
  const { error, value } = taskSchema.validate(req.body);
  if (error) return res.status(400).json({ error: error.message });
  const id = value.id || cryptoRandomId();
  db.prepare(`INSERT INTO tasks (id, user_id, title, notes, every_days, next_due, remind_at, priority, last_completed)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, req.user.id, value.title, value.notes || '', value.everyDays, value.nextDue, value.remindAt, value.priority ? 1 : 0, value.lastCompleted || null);
  res.status(201).json({ id });
});

app.put('/api/tasks/:id', authMiddleware, (req, res) => {
  const { error, value } = taskSchema.validate({ ...req.body, id: req.params.id });
  if (error) return res.status(400).json({ error: error.message });
  const result = db.prepare(`UPDATE tasks SET title=?, notes=?, every_days=?, next_due=?, remind_at=?, priority=?, last_completed=?
                             WHERE id=? AND user_id=?`)
    .run(value.title, value.notes || '', value.everyDays, value.nextDue, value.remindAt, value.priority ? 1 : 0, value.lastCompleted || null, req.params.id, req.user.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Task not found' });
  res.json({ ok: true });
});

app.delete('/api/tasks/:id', authMiddleware, (req, res) => {
  const result = db.prepare('DELETE FROM tasks WHERE id=? AND user_id=?').run(req.params.id, req.user.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Task not found' });
  res.json({ ok: true });
});

// Push endpoints (authenticated)
app.get('/api/push/vapid-public-key', (req, res) => {
  if (!VAPID_PUBLIC_KEY) return res.status(503).json({ error: 'Push not configured' });
  res.json({ key: VAPID_PUBLIC_KEY });
});

app.post('/api/push/subscribe', authMiddleware, (req, res) => {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return res.status(503).json({ error: 'Push not configured' });
  const { error, value } = subscriptionSchema.validate(req.body);
  if (error) return res.status(400).json({ error: error.message });
  try {
    db.prepare(`INSERT OR REPLACE INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, created_at)
                 VALUES ((SELECT id FROM push_subscriptions WHERE user_id=? AND endpoint=?), ?, ?, ?, ?, ?)`)
      .run(req.user.id, value.endpoint, req.user.id, value.endpoint, value.keys.p256dh, value.keys.auth, new Date().toISOString());
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Failed to save subscription' });
  }
});

app.delete('/api/push/subscribe', authMiddleware, (req, res) => {
  const { endpoint } = req.body || {};
  if (!endpoint) return res.status(400).json({ error: 'endpoint required' });
  const result = db.prepare('DELETE FROM push_subscriptions WHERE user_id=? AND endpoint=?').run(req.user.id, endpoint);
  res.json({ ok: true, removed: result.changes });
});

// Health
app.get('/healthz', (req, res) => res.json({ ok: true }));

// Friendly landing page so users don't see "Cannot GET /" after accepting the TLS warning
app.get('/', (req, res) => {
  const origin = ORIGIN;
  const beUrl = `https://${req.headers.host || 'localhost:8443'}`;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>TickTock Backend</title>
  <style>
    body{font-family: system-ui, -apple-system, Segoe UI, Roboto, Ubuntu, Cantarell, Noto Sans, Helvetica, Arial, sans-serif; margin: 2rem; color: #111}
    .card{max-width: 720px; border: 1px solid #e5e7eb; border-radius: 12px; padding: 1.25rem}
    h1{margin: 0 0 .5rem 0; font-size: 1.5rem}
    code{background:#f3f4f6; padding: .15rem .35rem; border-radius: 6px}
    .ok{color:#16a34a; font-weight:600}
    a{color:#2563eb; text-decoration: none}
  </style>
</head>
<body>
  <div class="card">
    <h1>TickTock Tasks – Backend is running ✅</h1>
    <p class="ok">HTTPS OK at <code>${beUrl}</code></p>
    <p>If you opened this to trust the self-signed certificate, you're all set.</p>
    <ul>
      <li>Frontend origin (CORS): <code>${origin}</code></li>
      <li>Health check: <a href="/healthz">/healthz</a></li>
    </ul>
    <p>Next, set your frontend to use this backend URL:<br>
      <code>${beUrl}</code>
    </p>
    <p>In production, this is automated by writing <code>config.js</code> to your S3 site via <code>infra/scripts/link-frontend.sh</code>.</p>
    <p style="margin-top:.75rem;color:#6b7280">© 2025 CodeSmith Consulting. All rights reserved.</p>
  </div>
</body>
</html>`);
});

// Background scheduler to send due notifications
const SCAN_INTERVAL_MS = 60 * 1000; // 1 minute
function combineDueDateTime(next_due, remind_at) {
  // Due in server's local time
  const [y, m, d] = next_due.split('-').map(Number);
  const [hh, mm] = remind_at.split(':').map(Number);
  return new Date(y, (m || 1) - 1, d || 1, hh || 0, mm || 0, 0, 0);
}

async function sendPushToUser(userId, payloadObj) {
  const subs = db.prepare('SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id=?').all(userId);
  const payload = JSON.stringify(payloadObj);
  for (const s of subs) {
    const sub = { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } };
    try {
      await webpush.sendNotification(sub, payload);
    } catch (e) {
      // Remove gone subscriptions
      const message = e?.body || e?.message || '';
      if (e?.statusCode === 404 || e?.statusCode === 410 || message.includes('gone')) {
        db.prepare('DELETE FROM push_subscriptions WHERE endpoint=?').run(s.endpoint);
      }
    }
  }
}

async function scanAndNotify() {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return; // push disabled
  const now = new Date();
  const windowStart = new Date(now.getTime() - SCAN_INTERVAL_MS);

  const rows = db.prepare('SELECT id, user_id, title, notes, every_days, next_due, remind_at, last_completed FROM tasks').all();
  const todayYmd = ymdLocal(now);

  for (const r of rows) {
    const due = combineDueDateTime(r.next_due, r.remind_at);
    const baseKey = `${r.next_due}T${r.remind_at}`;

    // 1) Day-of (send once when it's the due date and before due time)
    if (r.next_due === todayYmd && now < due) {
      const key = `${baseKey}|day`;
      const sent = db.prepare('SELECT 1 FROM notifications_sent WHERE task_id=? AND due_key=?').get(r.id, key);
      if (!sent) {
        const body = (r.notes ? `${r.notes}\n` : '') + `Due today at ${r.remind_at}`;
        await sendPushToUser(r.user_id, {
          type: 'task-day',
          taskId: r.id,
          title: `Today: ${r.title}`,
          body,
          icon: '/icons/logo.svg',
          badge: '/icons/logo.svg',
        });
        db.prepare('INSERT INTO notifications_sent (task_id, due_key, sent_at) VALUES (?, ?, ?)')
          .run(r.id, key, new Date().toISOString());
      }
    }

    // 2) 1-hour warning
    const oneHourBefore = new Date(due.getTime() - 60 * 60 * 1000);
    if (oneHourBefore <= now && oneHourBefore > windowStart && now < due) {
      const key = `${baseKey}|1h`;
      const sent = db.prepare('SELECT 1 FROM notifications_sent WHERE task_id=? AND due_key=?').get(r.id, key);
      if (!sent) {
        const body = (r.notes ? `${r.notes}\n` : '') + `~1 hour until due (${r.remind_at})`;
        await sendPushToUser(r.user_id, {
          type: 'task-hour',
          taskId: r.id,
          title: `1 hour left: ${r.title}`,
          body,
          icon: '/icons/logo.svg',
          badge: '/icons/logo.svg',
        });
        db.prepare('INSERT INTO notifications_sent (task_id, due_key, sent_at) VALUES (?, ?, ?)')
          .run(r.id, key, new Date().toISOString());
      }
    }

    // 3) Due time (existing behavior)
    if (due <= now && due > windowStart) {
      const key = baseKey;
      const sent = db.prepare('SELECT 1 FROM notifications_sent WHERE task_id=? AND due_key=?').get(r.id, key);
      if (!sent) {
        const body = r.notes ? `${r.notes}\nEvery ${r.every_days} day(s)` : `Every ${r.every_days} day(s)`;
        await sendPushToUser(r.user_id, {
          type: 'task-due',
          taskId: r.id,
          title: r.title,
          body,
          icon: '/icons/logo.svg',
          badge: '/icons/logo.svg',
        });
        db.prepare('INSERT INTO notifications_sent (task_id, due_key, sent_at) VALUES (?, ?, ?)')
          .run(r.id, key, new Date().toISOString());
      }
    }

    // 4) Missed (trigger if due is at least one scan window in the past to avoid same-scan with due)
    if (due <= windowStart) {
      const key = `${baseKey}|missed`;
      const sent = db.prepare('SELECT 1 FROM notifications_sent WHERE task_id=? AND due_key=?').get(r.id, key);
      if (!sent) {
        const newDue = addDaysYmd(r.next_due, 1);
        db.prepare('UPDATE tasks SET next_due=?, priority=1 WHERE id=?').run(newDue, r.id);
        const body = (r.notes ? `${r.notes}\n` : '') + `Missed. New deadline: same time tomorrow`;
        await sendPushToUser(r.user_id, {
          type: 'task-missed',
          taskId: r.id,
          title: `Missed: ${r.title}`,
          body,
          icon: '/icons/logo.svg',
          badge: '/icons/logo.svg',
        });
        db.prepare('INSERT INTO notifications_sent (task_id, due_key, sent_at) VALUES (?, ?, ?)')
          .run(r.id, key, new Date().toISOString());
      }
    }
  }
}

setInterval(() => { scanAndNotify().catch(() => {}); }, SCAN_INTERVAL_MS);

// Start servers (HTTPS preferred)
(function startServers(){
  const hasHttps = HTTPS_CERT_PATH && HTTPS_KEY_PATH && fs.existsSync(HTTPS_CERT_PATH) && fs.existsSync(HTTPS_KEY_PATH);
  const redirectHttp = String(process.env.REDIRECT_HTTP_TO_HTTPS ?? 'true').toLowerCase() !== 'false';
  if (hasHttps) {
    try {
      const key = fs.readFileSync(HTTPS_KEY_PATH);
      const cert = fs.readFileSync(HTTPS_CERT_PATH);
      https.createServer({ key, cert }, app).listen(HTTPS_PORT, () => {
        console.log(`TickTock Tasks HTTPS server listening on :${HTTPS_PORT}`);
      });

      if (redirectHttp) {
        // Optional HTTP -> HTTPS redirect
        http.createServer((req, res) => {
          const host = req.headers.host || '';
          const redirectHost = host.replace(/:\d+$/, '') + ':' + HTTPS_PORT;
          const location = `https://${redirectHost}${req.url || ''}`;
          res.statusCode = 301;
          res.setHeader('Location', location);
          res.end(`Redirecting to ${location}`);
        }).listen(PORT, () => {
          console.log(`HTTP redirect server listening on :${PORT} -> 443:${HTTPS_PORT}`);
        });
      } else {
        // Serve HTTP API without redirect (development fallback)
        http.createServer(app).listen(PORT, () => {
          console.log(`TickTock Tasks HTTP server listening on :${PORT} (no redirect)`);
        });
      }
      return;
    } catch (e) {
      console.error('Failed to start HTTPS server, falling back to HTTP:', e?.message || e);
    }
  }
  app.listen(PORT, () => {
    console.log(`TickTock Tasks HTTP server listening on :${PORT}`);
  });
})();

// Helpers
function cryptoRandomId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return 'id-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function ymdLocal(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const da = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${da}`;
}

function addDaysYmd(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(y, (m || 1) - 1, d || 1, 0, 0, 0, 0);
  dt.setDate(dt.getDate() + n);
  return ymdLocal(dt);
}
