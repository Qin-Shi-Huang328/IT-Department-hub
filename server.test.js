const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const { once } = require('node:events');
const crypto = require('node:crypto');
const { app, pool, startServer } = require('./server');

const adminConfig = {
  ADMIN_USERNAME: process.env.ADMIN_USERNAME,
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD,
  ADMIN_AUTH_SECRET: process.env.ADMIN_AUTH_SECRET
};

let server;
let baseUrl;

before(async () => {
  process.env.ADMIN_USERNAME = 'test-admin';
  process.env.ADMIN_PASSWORD = 'test-password';
  process.env.ADMIN_AUTH_SECRET = 'test-secret-with-at-least-32-characters';
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  for (const [key, value] of Object.entries(adminConfig)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test('admin login rejects invalid credentials', async () => {
  const response = await fetch(`${baseUrl}/hub/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'wrong', password: 'wrong' })
  });

  assert.equal(response.status, 401);
  assert.equal((await response.json()).error, 'Incorrect username or password');
});

test('Registrar route serves the authenticated student-management page', async () => {
  const response = await fetch(`${baseUrl}/registrar`);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /Student Registrar/);
  assert.match(html, /Add Student/);
  assert.match(html, /administrator employee/i);
});

test('admin login issues a token for valid credentials', async () => {
  const response = await fetch(`${baseUrl}/hub/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'test-admin', password: 'test-password' })
  });
  const data = await response.json();

  assert.equal(response.status, 200);
  assert.equal(typeof data.token, 'string');
  assert.equal(data.token.split('.').length, 2);
});

test('admin endpoints reject missing and non-admin tokens', async () => {
  const unauthenticated = await fetch(`${baseUrl}/hub/admin/employees`);
  assert.equal(unauthenticated.status, 401);

  const payload = Buffer.from(JSON.stringify({ sid: 'student-1', type: 'student', exp: Date.now() + 60_000 })).toString('base64url');
  const signature = crypto.createHmac('sha256', process.env.ADMIN_AUTH_SECRET).update(payload).digest('base64url');
  const studentToken = `${payload}.${signature}`;
  const forbidden = await fetch(`${baseUrl}/hub/admin/employees`, {
    headers: { Authorization: `Bearer ${studentToken}` }
  });
  assert.equal(forbidden.status, 401);
});

test('admin login remains disabled when configuration is missing', async () => {
  const savedSecret = process.env.ADMIN_AUTH_SECRET;
  const savedStudentSecret = process.env.STUDENT_RECORDS_AUTH_SECRET;
  const savedAuthSecret = process.env.AUTH_SECRET;
  delete process.env.ADMIN_AUTH_SECRET;
  delete process.env.STUDENT_RECORDS_AUTH_SECRET;
  delete process.env.AUTH_SECRET;
  try {
    const response = await fetch(`${baseUrl}/hub/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'test-admin', password: 'test-password' })
    });
    assert.equal(response.status, 503);
  } finally {
    process.env.ADMIN_AUTH_SECRET = savedSecret;
    if (savedStudentSecret === undefined) delete process.env.STUDENT_RECORDS_AUTH_SECRET;
    else process.env.STUDENT_RECORDS_AUTH_SECRET = savedStudentSecret;
    if (savedAuthSecret === undefined) delete process.env.AUTH_SECRET;
    else process.env.AUTH_SECRET = savedAuthSecret;
  }
});

test('status endpoint reports a database outage without leaking connection details', async () => {
  const originalQuery = pool.query;
  pool.query = async () => { throw new Error('database unavailable'); };
  try {
    const response = await fetch(`${baseUrl}/hub/status`);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      error: 'Unable to read registered systems from the Hub database'
    });
  } finally {
    pool.query = originalQuery;
  }
});

test('startup requires a dedicated Hub database URL', async () => {
  const savedHubUrl = process.env.HUB_DATABASE_URL;
  const savedLegacyUrl = process.env.DATABASE_URL;
  delete process.env.HUB_DATABASE_URL;
  delete process.env.DATABASE_URL;
  try {
    await assert.rejects(startServer(), /HUB_DATABASE_URL is required/);
  } finally {
    if (savedHubUrl === undefined) delete process.env.HUB_DATABASE_URL;
    else process.env.HUB_DATABASE_URL = savedHubUrl;
    if (savedLegacyUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = savedLegacyUrl;
  }
});