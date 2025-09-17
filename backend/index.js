import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import dotenv from 'dotenv';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import morgan from 'morgan';
// SQLite removed. Using DynamoDB for persistence.
import { ensureTables, getUserByEmail, createUser, listTasks as ddbListTasks, putTask as ddbPutTask, deleteTask as ddbDeleteTask, listSubs, putSub, delSub, notifWasSent, markNotifSent, ddb, TABLES } from './dynamo.js';
import Joi from 'joi';
import webpush from 'web-push';
import fs from 'fs';
import http from 'http';
import https from 'https';
import { ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

dotenv.config();

const app = express();
// Trust proxy when behind Nginx so rate-limit and IPs work correctly
app.set('trust proxy', true);
const PORT = parseInt(process.env.PORT || '8080', 10);
const HTTPS_PORT = parseInt(process.env.HTTPS_PORT || '8443', 10);
const HTTPS_CERT_PATH = process.env.HTTPS_CERT_PATH || '';
const HTTPS_KEY_PATH = process.env.HTTPS_KEY_PATH || '';
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const ORIGIN = process.env.CORS_ORIGIN || 'http://localhost:8000';
const NODE_ENV = process.env.NODE_ENV || 'development';
const COOKIE_SECURE = NODE_ENV === 'production';
// DynamoDB: tables are auto-provisioned. Optionally set DDB_TABLE_PREFIX (default 'ttt').
const VAPID_PUBLIC_KEY = process.env.WEB_PUSH_PUBLIC_KEY || '';
const VAPID_PRIVATE_KEY = process.env.WEB_PUSH_PRIVATE_KEY || '';

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(`mailto:admin@example.com`, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

// DB setup → DynamoDB (ensure tables once at startup)
await ensureTables().catch((e)=>{ console.error('DynamoDB ensureTables failed', e); });

// Security middleware
app.use(helmet());
app.use(morgan('dev'));
app.use(express.json({ limit: '256kb' }));
app.use(cookieParser());
// Build allowed origins list: env-provided plus safe defaults for our production domains
const ENV_ORIGINS = (process.env.CORS_ORIGIN || ORIGIN).split(',').map(s => s.trim()).filter(Boolean);
const SAFE_DEFAULTS = ['https://ticktocktasks.com', 'https://www.ticktocktasks.com'];
const ORIGINS = Array.from(new Set([...ENV_ORIGINS, ...SAFE_DEFAULTS]));
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
  // When served over HTTPS in production (behind Nginx on api.<domain>),
  // the web app runs on a different site (https://<domain>) → cross-site cookie.
  // Modern browsers require SameSite=None; Secure for such cookies.
  const cookieOpts = {
    httpOnly: true,
    secure: COOKIE_SECURE,
    sameSite: COOKIE_SECURE ? 'none' : 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: '/',
  };
  res.cookie('tt_auth', token, cookieOpts);
}

function clearAuthCookie(res) {
  const opts = { path: '/', secure: COOKIE_SECURE, sameSite: COOKIE_SECURE ? 'none' : 'lax' };
  res.clearCookie('tt_auth', opts);
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
  category: Joi.alternatives().try(Joi.string().allow('', 'Default').max(100), Joi.valid(null)).optional(),
  everyDays: Joi.number().integer().min(1).max(3650).required(),
  scheduleDays: Joi.array().items(Joi.number().integer().min(0).max(6)).optional(),
  nextDue: Joi.string().regex(/^\d{4}-\d{2}-\d{2}$/).required(),
  remindAt: Joi.string().regex(/^\d{2}:\d{2}$/).required(),
  priority: Joi.boolean().optional(),
  lastCompleted: Joi.string().allow(null).optional(),
}).unknown(true);

const subscriptionSchema = Joi.object({
  endpoint: Joi.string().uri().required(),
  expirationTime: Joi.any().allow(null),
  keys: Joi.object({ p256dh: Joi.string().required(), auth: Joi.string().required() }).required(),
});

// Auth routes
app.post('/api/auth/register', authLimiter, async (req, res) => {
  try {
    const { error, value } = registerSchema.validate(req.body);
    if (error) return res.status(400).json({ error: error.message });

    const email = value.email.toLowerCase();
    const existing = await getUserByEmail(email);
    if (existing) return res.status(409).json({ error: 'Email already registered' });
    const hash = bcrypt.hashSync(value.password, 10);
    const userRec = await createUser(email, hash);
    const user = { id: userRec.id, email: userRec.email };
    const token = issueToken(user);
    setAuthCookie(res, token);
    res.json({ ok: true, token, user: { id: user.id, email: user.email } });
  } catch (e) {
    console.error('Auth register error', e?.message || e);
    return res.status(500).json({ error: 'Registration failed' });
  }
});

app.post('/api/auth/login', authLimiter, async (req, res) => {
  try {
    const { error, value } = loginSchema.validate(req.body);
    if (error) return res.status(400).json({ error: error.message });

    const email = value.email.toLowerCase();
    const row = await getUserByEmail(email);
    if (!row) return res.status(401).json({ error: 'Invalid credentials' });
    const ok = bcrypt.compareSync(value.password, row.password_hash);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });
    const token = issueToken({ id: row.id, email: row.email });
    setAuthCookie(res, token);
    res.json({ ok: true, token, user: { id: row.id, email: row.email } });
  } catch (e) {
    console.error('Auth login error', e?.message || e);
    return res.status(500).json({ error: 'Login failed' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  clearAuthCookie(res);
  res.json({ ok: true });
});

app.get('/api/auth/me', authMiddleware, (req, res) => {
  res.json({ user: { id: req.user.id, email: req.user.email } });
});

// Task routes (authenticated)
app.get('/api/tasks', authMiddleware, async (req, res) => {
  const rows = await ddbListTasks(String(req.user.id));
  const tasks = rows.map(r => ({
    id: r.id,
    title: r.title,
    notes: r.notes || '',
    category: r.category || 'Default',
    everyDays: r.every_days ?? r.everyDays,
    scheduleDays: r.schedule_days ?? r.scheduleDays,
    nextDue: r.next_due ?? r.nextDue,
    remindAt: r.remind_at ?? r.remindAt,
    priority: !!(r.priority ?? false),
    lastCompleted: r.last_completed ?? r.lastCompleted,
  }));
  res.json({ tasks });
});

app.post('/api/tasks', authMiddleware, async (req, res) => {
  // Be maximally compatible: accept any payload shape and coerce
  const b = req.body || {};
  const id = (b.id && String(b.id)) || cryptoRandomId();
  const item = {
    id,
    user_id: String(req.user.id),
    title: (b.title && String(b.title)) || 'Untitled',
    notes: (b.notes != null ? String(b.notes) : ''),
    category: (b.category == null || b.category === '') ? 'Default' : String(b.category),
    every_days: Number.isFinite(b.everyDays) ? b.everyDays : Number(b.everyDays || 1),
    schedule_days: Array.isArray(b.scheduleDays) ? b.scheduleDays : undefined,
    next_due: (b.nextDue && String(b.nextDue)) || new Date().toISOString().slice(0,10),
    remind_at: (b.remindAt && String(b.remindAt)) || '09:00',
    priority: !!b.priority,
    last_completed: b.lastCompleted ? String(b.lastCompleted) : null,
  };
  await ddbPutTask(item);
  res.status(201).json({ id });
});

app.put('/api/tasks/:id', authMiddleware, async (req, res) => {
  // Max compatibility: accept category and other extra fields without error
  const b = { ...(req.body || {}), id: req.params.id };
  const item = {
    id: String(req.params.id),
    user_id: String(req.user.id),
    title: (b.title && String(b.title)) || 'Untitled',
    notes: (b.notes != null ? String(b.notes) : ''),
    category: (b.category == null || b.category === '') ? 'Default' : String(b.category),
    every_days: Number.isFinite(b.everyDays) ? b.everyDays : Number(b.everyDays || 1),
    schedule_days: Array.isArray(b.scheduleDays) ? b.scheduleDays : undefined,
    next_due: (b.nextDue && String(b.nextDue)) || new Date().toISOString().slice(0,10),
    remind_at: (b.remindAt && String(b.remindAt)) || '09:00',
    priority: !!b.priority,
    last_completed: b.lastCompleted ? String(b.lastCompleted) : null,
  };
  await ddbPutTask(item);
  res.json({ ok: true });
});

app.delete('/api/tasks/:id', authMiddleware, async (req, res) => {
  await ddbDeleteTask(String(req.user.id), req.params.id);
  res.json({ ok: true });
});

// Push endpoints (authenticated)
app.get('/api/push/vapid-public-key', (req, res) => {
  if (!VAPID_PUBLIC_KEY) {
    // Return 200 with empty key to avoid frontend console errors/noise when push is not configured
    return res.json({ key: '' });
  }
  res.json({ key: VAPID_PUBLIC_KEY });
});

app.post('/api/push/subscribe', authMiddleware, async (req, res) => {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return res.status(503).json({ error: 'Push not configured' });
  const { error, value } = subscriptionSchema.validate(req.body);
  if (error) return res.status(400).json({ error: error.message });
  try {
    await putSub(String(req.user.id), value.endpoint, value.keys.p256dh, value.keys.auth);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Failed to save subscription' });
  }
});

app.delete('/api/push/subscribe', authMiddleware, async (req, res) => {
  const { endpoint } = req.body || {};
  if (!endpoint) return res.status(400).json({ error: 'endpoint required' });
  await delSub(String(req.user.id), endpoint);
  res.json({ ok: true, removed: 1 });
});

// Send a test push notification to current user's subscriptions
app.post('/api/push/test', authMiddleware, async (req, res) => {
  try {
    if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
      return res.status(503).json({ error: 'Push not configured' });
    }
    const userId = String(req.user.id);
    const payload = {
      type: 'test',
      title: 'TickTock Tasks: Test Notification',
      body: 'If you see this, push notifications are working for your account on this device.',
      icon: '/icons/logo.svg',
      badge: '/icons/logo.svg',
      ts: new Date().toISOString(),
    };
    await sendPushToUser(userId, payload);
    return res.json({ ok: true, sent: true });
  } catch (e) {
    console.error('push test failed', e?.message || e);
    return res.status(500).json({ error: 'Failed to send test push' });
  }
});

// Health and ping (no auth)
app.get('/api/ping', (req, res) => {
  res.json({
    ok: true,
    service: 'ttt-backend',
    time: new Date().toISOString(),
    uptimeSec: Math.round(process.uptime())
  });
});
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
      <li>Standalone App (served by backend): <a href="/app/">/app/</a></li>
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

// Serve a standalone copy of the web app from the backend under /app
// This keeps the app reachable even if the main website (S3/CloudFront) is down.
app.get(['/app','/app/','/app/index.html'], (req, res) => {
  try {
    const html = fs.readFileSync('./public/index.html');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.end(html);
  } catch (e) {
    res.status(404).send('App not bundled');
  }
});

app.get('/app/config.js', (req, res) => {
  // Force same-origin relative API when loading the app from backend
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.end("window.RUNTIME_CONFIG=Object.assign({},window.RUNTIME_CONFIG||{},{BACKEND_URL:''});\n");
});

app.use('/app', express.static('public', { maxAge: '30d' }));

// Background scheduler to send due notifications
const SCAN_INTERVAL_MS = 60 * 1000; // 1 minute
function combineDueDateTime(next_due, remind_at) {
  // Due in server's local time
  const [y, m, d] = next_due.split('-').map(Number);
  const [hh, mm] = remind_at.split(':').map(Number);
  return new Date(y, (m || 1) - 1, d || 1, hh || 0, mm || 0, 0, 0);
}

async function sendPushToUser(userId, payloadObj) {
  const subs = await listSubs(String(userId));
  const payload = JSON.stringify(payloadObj);
  for (const s of subs) {
    const sub = { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } };
    try {
      await webpush.sendNotification(sub, payload);
    } catch (e) {
      const message = e?.body || e?.message || '';
      if (e?.statusCode === 404 || e?.statusCode === 410 || message.includes('gone')) {
        await delSub(String(userId), s.endpoint);
      }
    }
  }
}

async function scanAndNotify() {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return; // push disabled
  const now = new Date();
  const windowStart = new Date(now.getTime() - SCAN_INTERVAL_MS);

  // Scan all tasks (bounded by table size; PAY_PER_REQUEST handles scaling). 
  // Minimal approach to avoid secondary indexes. If scale grows, switch to partitioned scans.
  let rows = [];
  try {
    const r = await ddb.send(new ScanCommand({ TableName: TABLES.tasks }));
    rows = r.Items || [];
  } catch (e) {
    console.error('scanAndNotify: Scan tasks failed', e?.message || e);
    return;
  }

  const todayYmd = ymdLocal(now);

  for (const r of rows) {
    try {
      if (!r.next_due || !r.remind_at || !r.id || !r.user_id) continue;
      const due = combineDueDateTime(String(r.next_due), String(r.remind_at));
      const baseKey = `${r.next_due}T${r.remind_at}`;

      // 1) Day-of (send once when it's the due date and before due time)
      if (String(r.next_due) === todayYmd && now < due) {
        const key = `${baseKey}|day`;
        const sent = await notifWasSent(String(r.id), key);
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
          await markNotifSent(String(r.id), key);
        }
      }

      // 2) 1-hour warning
      const oneHourBefore = new Date(due.getTime() - 60 * 60 * 1000);
      if (oneHourBefore <= now && oneHourBefore > windowStart && now < due) {
        const key = `${baseKey}|1h`;
        const sent = await notifWasSent(String(r.id), key);
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
          await markNotifSent(String(r.id), key);
        }
      }

      // 3) Due time
      if (due <= now && due > windowStart) {
        const key = baseKey;
        const sent = await notifWasSent(String(r.id), key);
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
          await markNotifSent(String(r.id), key);
        }
      }

      // 4) Missed (trigger if due is at least one scan window in the past)
      if (due <= windowStart) {
        const key = `${baseKey}|missed`;
        const sent = await notifWasSent(String(r.id), key);
        if (!sent) {
          const newDue = addDaysYmd(String(r.next_due), 1);
          // Update task next_due and priority=true
          try {
            await ddb.send(new UpdateCommand({
              TableName: TABLES.tasks,
              Key: { user_id: String(r.user_id), id: String(r.id) },
              UpdateExpression: 'SET next_due = :nd, priority = :p',
              ExpressionAttributeValues: { ':nd': newDue, ':p': true },
            }));
          } catch (e) {
            console.error('scanAndNotify: failed to roll missed task', r.id, e?.message || e);
          }
          const body = (r.notes ? `${r.notes}\n` : '') + `Missed. New deadline: same time tomorrow`;
          await sendPushToUser(r.user_id, {
            type: 'task-missed',
            taskId: r.id,
            title: `Missed: ${r.title}`,
            body,
            icon: '/icons/logo.svg',
            badge: '/icons/logo.svg',
          });
          await markNotifSent(String(r.id), key);
        }
      }
    } catch (e) {
      console.error('scanAndNotify: error for task', r?.id, e?.message || e);
    }
  }
}

setInterval(() => { scanAndNotify().catch(() => {}); }, SCAN_INTERVAL_MS);

// Error handler (last middleware) – logs full error details which go to CloudWatch when running in EC2
app.use((err, req, res, next) => {
  try {
    console.error('Unhandled error', {
      path: req?.path,
      method: req?.method,
      message: err?.message,
      stack: err?.stack,
    });
  } catch (e) {
    console.error('Unhandled error (stringified):', String(err));
  }
  res.status(500).json({ error: 'Internal Server Error' });
});

// Start servers (HTTPS preferred)
(function startServers(){
  const hasHttps = HTTPS_CERT_PATH && HTTPS_KEY_PATH && fs.existsSync(HTTPS_CERT_PATH) && fs.existsSync(HTTPS_KEY_PATH);
  const redirectHttp = String(process.env.REDIRECT_HTTP_TO_HTTPS ?? 'false').toLowerCase() !== 'false';
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
