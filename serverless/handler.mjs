import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import Joi from 'joi';
import { v4 as uuidv4 } from 'uuid';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, DeleteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

const JWT_SECRET = process.env.JWT_SECRET || 'change-me';
const USERS_TABLE = process.env.USERS_TABLE;
const TASKS_TABLE = process.env.TASKS_TABLE;

const ddb = new DynamoDBClient({});
const doc = DynamoDBDocumentClient.from(ddb);

// Validation schemas (similar to server/index.js)
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
  nextDue: Joi.string().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/).required(),
  remindAt: Joi.string().regex(/^[0-9]{2}:[0-9]{2}$/).required(),
  priority: Joi.boolean().optional(),
  lastCompleted: Joi.string().allow(null).optional(),
});

function json(statusCode, body, corsOrigin) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': corsOrigin || '*',
      'Access-Control-Allow-Credentials': 'true',
    },
    body: JSON.stringify(body),
  };
}

function parseBody(event) {
  if (!event.body) return {};
  try { return JSON.parse(event.body); } catch { return {}; }
}

function issueToken(user) {
  return jwt.sign({ uid: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
}

function getAuth(event) {
  const auth = event.headers?.authorization || event.headers?.Authorization;
  if (!auth || !auth.startsWith('Bearer ')) return null;
  const token = auth.slice('Bearer '.length);
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    return { id: payload.uid, email: payload.email };
  } catch {
    return null;
  }
}

async function findUserByEmail(email) {
  // Users table PK: email (string); attributes: id (string), passwordHash
  const out = await doc.send(new GetCommand({ TableName: USERS_TABLE, Key: { email } }));
  return out.Item || null;
}

async function createUser(email, password) {
  const existing = await findUserByEmail(email);
  if (existing) return null;
  const id = uuidv4();
  const passwordHash = bcrypt.hashSync(password, 10);
  const item = { email, id, passwordHash, createdAt: new Date().toISOString() };
  await doc.send(new PutCommand({ TableName: USERS_TABLE, Item: item }));
  return { id, email };
}

// Tasks table PK/SK: userId (PK), id (SK)
async function listTasks(userId) {
  const out = await doc.send(new QueryCommand({
    TableName: TASKS_TABLE,
    KeyConditionExpression: '#u = :uid',
    ExpressionAttributeNames: { '#u': 'userId' },
    ExpressionAttributeValues: { ':uid': userId },
  }));
  return (out.Items || []).map(r => ({
    id: r.id,
    title: r.title,
    notes: r.notes || '',
    everyDays: r.everyDays,
    nextDue: r.nextDue,
    remindAt: r.remindAt,
    priority: !!r.priority,
    lastCompleted: r.lastCompleted || undefined,
  }));
}

async function putTask(userId, value) {
  const id = value.id || uuidv4();
  const item = {
    userId,
    id,
    title: value.title,
    notes: value.notes || '',
    everyDays: value.everyDays,
    nextDue: value.nextDue,
    remindAt: value.remindAt,
    priority: value.priority ? 1 : 0,
    lastCompleted: value.lastCompleted || null,
  };
  await doc.send(new PutCommand({ TableName: TASKS_TABLE, Item: item }));
  return id;
}

async function updateTask(userId, id, value) {
  // Overwrite with Put to keep it simple; in production, use UpdateExpression
  return putTask(userId, { ...value, id });
}

async function deleteTask(userId, id) {
  await doc.send(new DeleteCommand({ TableName: TASKS_TABLE, Key: { userId, id } }));
}

export async function handler(event) {
  const origin = event.headers?.origin || event.headers?.Origin || '*';
  const method = event.httpMethod;
  const path = event.path || '/';

  // Preflight
  if (method === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Credentials': 'true',
        'Access-Control-Allow-Headers': 'Content-Type,Authorization',
        'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
      },
      body: ''
    };
  }

  try {
    if (path === '/healthz' && method === 'GET') {
      return json(200, { ok: true }, origin);
    }

    if (path === '/api/auth/register' && method === 'POST') {
      const body = parseBody(event);
      const { error, value } = registerSchema.validate(body);
      if (error) return json(400, { error: error.message }, origin);
      const user = await createUser(value.email.toLowerCase(), value.password);
      if (!user) return json(409, { error: 'Email already registered' }, origin);
      const token = issueToken(user);
      return json(200, { ok: true, user, token }, origin);
    }

    if (path === '/api/auth/login' && method === 'POST') {
      const body = parseBody(event);
      const { error, value } = loginSchema.validate(body);
      if (error) return json(400, { error: error.message }, origin);
      const row = await findUserByEmail(value.email.toLowerCase());
      if (!row) return json(401, { error: 'Invalid credentials' }, origin);
      const ok = bcrypt.compareSync(value.password, row.passwordHash);
      if (!ok) return json(401, { error: 'Invalid credentials' }, origin);
      const token = issueToken({ id: row.id, email: row.email });
      return json(200, { ok: true, user: { id: row.id, email: row.email }, token }, origin);
    }

    if (path === '/api/auth/me' && method === 'GET') {
      const user = getAuth(event);
      if (!user) return json(401, { error: 'Unauthorized' }, origin);
      return json(200, { user }, origin);
    }

    if (path === '/api/tasks' && method === 'GET') {
      const user = getAuth(event);
      if (!user) return json(401, { error: 'Unauthorized' }, origin);
      const tasks = await listTasks(user.id);
      return json(200, { tasks }, origin);
    }

    if (path === '/api/tasks' && method === 'POST') {
      const user = getAuth(event);
      if (!user) return json(401, { error: 'Unauthorized' }, origin);
      const body = parseBody(event);
      const { error, value } = taskSchema.validate(body);
      if (error) return json(400, { error: error.message }, origin);
      const id = await putTask(user.id, value);
      return json(201, { id }, origin);
    }

    if (path.startsWith('/api/tasks/') && method === 'PUT') {
      const user = getAuth(event);
      if (!user) return json(401, { error: 'Unauthorized' }, origin);
      const id = decodeURIComponent(path.split('/').pop());
      const body = parseBody(event);
      const { error, value } = taskSchema.validate({ ...body, id });
      if (error) return json(400, { error: error.message }, origin);
      await updateTask(user.id, id, value);
      return json(200, { ok: true }, origin);
    }

    if (path.startsWith('/api/tasks/') && method === 'DELETE') {
      const user = getAuth(event);
      if (!user) return json(401, { error: 'Unauthorized' }, origin);
      const id = decodeURIComponent(path.split('/').pop());
      await deleteTask(user.id, id);
      return json(200, { ok: true }, origin);
    }

    return json(404, { error: 'Not found' }, origin);
  } catch (e) {
    console.error('Error:', e);
    return json(500, { error: 'Internal error' }, event.headers?.origin || '*');
  }
}
