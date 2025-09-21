import { DynamoDBClient, CreateTableCommand, DescribeTableCommand } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, UpdateCommand, DeleteCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';

const REGION = process.env.DDB_REGION || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1'; // default to us-east-1 if not provided
const TABLE_PREFIX = process.env.DDB_TABLE_PREFIX || 'ttt';

export const TABLES = {
  users: `${TABLE_PREFIX}-users`,
  tasks: `${TABLE_PREFIX}-tasks`,
  push: `${TABLE_PREFIX}-push`,
  notifs: `${TABLE_PREFIX}-notifs`,
  config: `${TABLE_PREFIX}-config`,
  irene_tasks: `${TABLE_PREFIX}-irene-tasks`,
  irene_logs: `${TABLE_PREFIX}-irene-logs`,
};

const client = new DynamoDBClient({ region: REGION });
export const ddb = DynamoDBDocumentClient.from(client, { marshallOptions: { removeUndefinedValues: true } });

async function ensureTableUsers(){
  const TableName = TABLES.users;
  try { await client.send(new DescribeTableCommand({ TableName })); return; } catch {}
  await client.send(new CreateTableCommand({
    TableName,
    BillingMode: 'PAY_PER_REQUEST',
    KeySchema: [{ AttributeName: 'email', KeyType: 'HASH' }],
    AttributeDefinitions: [{ AttributeName: 'email', AttributeType: 'S' }],
  }));
}

async function ensureTableTasks(){
  const TableName = TABLES.tasks;
  try { await client.send(new DescribeTableCommand({ TableName })); return; } catch {}
  await client.send(new CreateTableCommand({
    TableName,
    BillingMode: 'PAY_PER_REQUEST',
    KeySchema: [
      { AttributeName: 'user_id', KeyType: 'HASH' },
      { AttributeName: 'id', KeyType: 'RANGE' },
    ],
    AttributeDefinitions: [
      { AttributeName: 'user_id', AttributeType: 'S' },
      { AttributeName: 'id', AttributeType: 'S' },
    ],
  }));
}

async function ensureTablePush(){
  const TableName = TABLES.push;
  try { await client.send(new DescribeTableCommand({ TableName })); return; } catch {}
  await client.send(new CreateTableCommand({
    TableName,
    BillingMode: 'PAY_PER_REQUEST',
    KeySchema: [ { AttributeName: 'user_id', KeyType: 'HASH' }, { AttributeName: 'endpoint', KeyType: 'RANGE' } ],
    AttributeDefinitions: [ { AttributeName: 'user_id', AttributeType: 'S' }, { AttributeName: 'endpoint', AttributeType: 'S' } ],
  }));
}

async function ensureTableNotifs(){
  const TableName = TABLES.notifs;
  try { await client.send(new DescribeTableCommand({ TableName })); return; } catch {}
  await client.send(new CreateTableCommand({
    TableName,
    BillingMode: 'PAY_PER_REQUEST',
    KeySchema: [ { AttributeName: 'task_id', KeyType: 'HASH' }, { AttributeName: 'due_key', KeyType: 'RANGE' } ],
    AttributeDefinitions: [ { AttributeName: 'task_id', AttributeType: 'S' }, { AttributeName: 'due_key', AttributeType: 'S' } ],
  }));
}

async function ensureTableConfig(){
  const TableName = TABLES.config;
  try { await client.send(new DescribeTableCommand({ TableName })); return; } catch {}
  await client.send(new CreateTableCommand({
    TableName,
    BillingMode: 'PAY_PER_REQUEST',
    KeySchema: [ { AttributeName: 'key', KeyType: 'HASH' } ],
    AttributeDefinitions: [ { AttributeName: 'key', AttributeType: 'S' } ],
  }));
}

async function ensureTableIreneTasks(){
  const TableName = TABLES.irene_tasks;
  try { await client.send(new DescribeTableCommand({ TableName })); return; } catch {}
  await client.send(new CreateTableCommand({
    TableName,
    BillingMode: 'PAY_PER_REQUEST',
    KeySchema: [ { AttributeName: 'user_id', KeyType: 'HASH' }, { AttributeName: 'id', KeyType: 'RANGE' } ],
    AttributeDefinitions: [ { AttributeName: 'user_id', AttributeType: 'S' }, { AttributeName: 'id', AttributeType: 'S' } ],
  }));
}

async function ensureTableIreneLogs(){
  const TableName = TABLES.irene_logs;
  try { await client.send(new DescribeTableCommand({ TableName })); return; } catch {}
  await client.send(new CreateTableCommand({
    TableName,
    BillingMode: 'PAY_PER_REQUEST',
    KeySchema: [ { AttributeName: 'user_id', KeyType: 'HASH' }, { AttributeName: 'ts', KeyType: 'RANGE' } ],
    AttributeDefinitions: [ { AttributeName: 'user_id', AttributeType: 'S' }, { AttributeName: 'ts', AttributeType: 'S' } ],
  }));
}

export async function ensureTables(){
  await Promise.all([
    ensureTableUsers(),
    ensureTableTasks(),
    ensureTablePush(),
    ensureTableNotifs(),
    ensureTableConfig(),
    ensureTableIreneTasks(),
    ensureTableIreneLogs(),
  ]);
}

// Users
export async function getUserByEmail(email){
  const r = await ddb.send(new GetCommand({ TableName: TABLES.users, Key: { email } }));
  return r.Item || null;
}
export async function createUser(email, password_hash){
  const user = { email, password_hash, created_at: new Date().toISOString(), id: email };
  await ddb.send(new PutCommand({ TableName: TABLES.users, Item: user, ConditionExpression: 'attribute_not_exists(email)' }));
  return user;
}
export async function setUserTimezone(email, tzOffsetMinutes){
  await ddb.send(new UpdateCommand({
    TableName: TABLES.users,
    Key: { email },
    UpdateExpression: 'SET tzOffsetMinutes = :tz',
    ExpressionAttributeValues: { ':tz': tzOffsetMinutes }
  }));
}

// Tasks
export async function listTasks(user_id){
  const r = await ddb.send(new QueryCommand({ TableName: TABLES.tasks, KeyConditionExpression: 'user_id = :u', ExpressionAttributeValues: { ':u': user_id } }));
  return r.Items || [];
}
export async function putTask(task){
  await ddb.send(new PutCommand({ TableName: TABLES.tasks, Item: task }));
}
export async function deleteTask(user_id, id){
  await ddb.send(new DeleteCommand({ TableName: TABLES.tasks, Key: { user_id, id } }));
}

// Push subs
export async function listSubs(user_id){
  const r = await ddb.send(new QueryCommand({ TableName: TABLES.push, KeyConditionExpression: 'user_id = :u', ExpressionAttributeValues: { ':u': user_id } }));
  return r.Items || [];
}
export async function putSub(user_id, endpoint, p256dh, auth, tzOffsetMinutes){
  await ddb.send(new PutCommand({ TableName: TABLES.push, Item: { user_id, endpoint, p256dh, auth, tzOffsetMinutes, created_at: new Date().toISOString() } }));
}
export async function delSub(user_id, endpoint){
  await ddb.send(new DeleteCommand({ TableName: TABLES.push, Key: { user_id, endpoint } }));
}

// Irene tasks
export async function listIreneTasks(user_id){
  const r = await ddb.send(new QueryCommand({ TableName: TABLES.irene_tasks, KeyConditionExpression: 'user_id = :u', ExpressionAttributeValues: { ':u': user_id } }));
  return r.Items || [];
}
export async function putIreneTask(task){
  await ddb.send(new PutCommand({ TableName: TABLES.irene_tasks, Item: task }));
}
export async function deleteIreneTask(user_id, id){
  await ddb.send(new DeleteCommand({ TableName: TABLES.irene_tasks, Key: { user_id, id } }));
}

// Irene logs
export async function logIreneCompletion(user_id, task_id, ts){
  const item = { user_id, ts, task_id };
  await ddb.send(new PutCommand({ TableName: TABLES.irene_logs, Item: item }));
  return item;
}
export async function queryIreneLogs(user_id, fromTs, toTs){
  // Simple scan by range using begins_with on prefix or between; ts stored as ISO string allows lexicographic ordering
  const r = await ddb.send(new QueryCommand({
    TableName: TABLES.irene_logs,
    KeyConditionExpression: 'user_id = :u AND ts BETWEEN :from AND :to',
    ExpressionAttributeValues: { ':u': user_id, ':from': fromTs, ':to': toTs },
  }));
  return r.Items || [];
}

// Notifs (idempotence keys)
export async function notifWasSent(task_id, due_key){
  const r = await ddb.send(new GetCommand({ TableName: TABLES.notifs, Key: { task_id, due_key } }));
  return !!r.Item;
}
export async function markNotifSent(task_id, due_key){
  await ddb.send(new PutCommand({ TableName: TABLES.notifs, Item: { task_id, due_key, sent_at: new Date().toISOString() } }));
}
