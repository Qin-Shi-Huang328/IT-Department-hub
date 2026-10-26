require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const fetch = require('node-fetch');
const { Pool } = require('pg');
const { createStudentRecordsRouter, initializeStudentRecordsDatabase } = require('./student-records');

const app = express();
app.use(cors());
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.HUB_DATABASE_URL || process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const SYSTEM_API_KEY_ENV = {
  'student-records': 'STUDENT_RECORDS_API_KEY',
  enrollment: 'ENROLLMENT_API_KEY',
  finance: 'FINANCE_API_KEY',
  lms: 'LMS_API_KEY',
  'web-portal': 'WEB_PORTAL_API_KEY'
};
const studentRecordsPool = process.env.STUDENT_RECORDS_DATABASE_URL ? new Pool({
  connectionString: process.env.STUDENT_RECORDS_DATABASE_URL,
  ssl: { rejectUnauthorized: false }
}) : null;

function getSystemApiKey(systemKey) {
  const envName = SYSTEM_API_KEY_ENV[systemKey];
  const apiKey = process.env[envName] || (systemKey === 'student-records' ? process.env.API_KEY : '');
  return apiKey;
}

function fetchFromSystem(systemKey, url, options = {}) {
  const apiKey = getSystemApiKey(systemKey);
  const headers = { ...(options.headers || {}) };
  if (apiKey) headers['x-api-key'] = apiKey;
  return fetch(url, {
    ...options,
    headers
  });
}

async function sendSystemResponse(res, response) {
  const body = await response.text();
  try {
    return res.status(response.status).json(JSON.parse(body));
  } catch {
    return res.status(response.status).json({
      error: `System returned a non-JSON response (HTTP ${response.status})`
    });
  }
}

function requireApiKey(req, res, next) {
  const key = req.header('x-api-key');
  if (!key || key !== process.env.API_KEY) {
    return res.status(401).json({ error: 'Missing or invalid API key' });
  }
  next();
}

app.use('/api', createStudentRecordsRouter({
  pool: studentRecordsPool,
  getApiKey: () => process.env.STUDENT_RECORDS_API_KEY || process.env.API_KEY,
  getAuthSecret: () => process.env.STUDENT_RECORDS_AUTH_SECRET || process.env.AUTH_SECRET
}));

async function getRegistry() {
  const result = await pool.query('SELECT key, name, base_url FROM systems');
  const registry = {};
  for (const row of result.rows) {
    registry[row.key] = { key: row.key, name: row.name, baseUrl: row.base_url };
  }
  return registry;
}

function verifyToken(token, authSecret = process.env.STUDENT_RECORDS_AUTH_SECRET || process.env.AUTH_SECRET) {
  if (!token || !authSecret) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payload, sig] = parts;
  const expected = crypto.createHmac('sha256', authSecret).update(payload).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (!data.sid || !data.exp || Date.now() > data.exp) return null;
    return data;
  } catch {
    return null;
  }
}

function requireOwnRecord(req, res, next) {
  const auth = req.header('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const data = verifyToken(token);
  if (!data) return res.status(401).json({ error: 'Please log in again' });
  if (data.type === 'employee') return next();
  if (data.sid !== req.params.id) return res.status(403).json({ error: 'You can only view your own record' });
  next();
}

function requireEmployee(req, res, next) {
  const auth = req.header('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const data = verifyToken(token);
  if (!data) return res.status(401).json({ error: 'Please log in again' });
  if (data.type !== 'employee') return res.status(403).json({ error: 'Employee access required' });
  next();
}

function requireAdmin(req, res, next) {
  const auth = req.header('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const data = verifyToken(token, process.env.ADMIN_AUTH_SECRET || process.env.STUDENT_RECORDS_AUTH_SECRET || process.env.AUTH_SECRET);
  if (!data || data.type !== 'admin') return res.status(401).json({ error: 'Admin sign-in required' });
  next();
}

async function proxySystemRequest(res, systemKey, path, options = {}) {
  const registry = await getRegistry();
  const system = registry[systemKey];
  if (!system) return res.status(503).json({ error: `${systemKey} system not configured` });
  const response = await fetchFromSystem(systemKey, `${system.baseUrl.replace(/\/$/, '')}${path}`, options);
  return sendSystemResponse(res, response);
}

app.get('/dashboard', (req, res) => res.sendFile(require('path').join(__dirname, 'user-dashboard.html')));
app.get('/admin', (req, res) => res.sendFile(require('path').join(__dirname, 'Admin-dashboard.html')));
app.get('/registrar', (req, res) => res.sendFile(require('path').join(__dirname, 'Admin-dashboard.html')));
app.get('/status', (req, res) => res.sendFile(require('path').join(__dirname, 'hub-ui.html')));

app.get('/', (req, res) => {
  res.json({ message: 'Central Hub is running' });
});

// Self-registration endpoint
app.post('/hub/register', requireApiKey, async (req, res) => {
  const { key, name, base_url } = req.body;
  if (!key || !name || !base_url) {
    return res.status(400).json({ error: 'key, name, and base_url are required' });
  }
  if (!SYSTEM_API_KEY_ENV[key]) {
    return res.status(400).json({ error: 'Unsupported system key' });
  }
  try {
    const test = await fetchFromSystem(key, `${base_url.replace(/\/$/, '')}/api/db-check`);
    if (!test.ok) {
      return res.status(400).json({ error: 'Could not reach your system at that URL. Make sure it is deployed and /api/db-check returns 200.' });
    }
    await pool.query(
      `INSERT INTO systems (key, name, base_url)
       VALUES ($1, $2, $3)
       ON CONFLICT (key) DO UPDATE SET name = $2, base_url = $3, registered_at = NOW()`,
      [key, name, base_url]
    );
    res.json({ ok: true, message: `${name} registered successfully with the IT Department Hub!` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Student login
app.post('/hub/login', async (req, res) => {
  try {
    const registry = await getRegistry();
    const sr = registry['student-records'];
    if (!sr) return res.status(503).json({ error: 'Student Records not configured' });
    const r = await fetchFromSystem('student-records', `${sr.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ student_id: (req.body || {}).student_id, password: (req.body || {}).password })
    });
    return await sendSystemResponse(res, r);
  } catch (err) {
    res.status(502).json({ error: 'Failed to reach Student Records', details: err.message });
  }
});

// Employee login
app.post('/hub/staff-login', async (req, res) => {
  try {
    const registry = await getRegistry();
    const sr = registry['student-records'];
    if (!sr) return res.status(503).json({ error: 'Student Records not configured' });
    const r = await fetchFromSystem('student-records', `${sr.baseUrl}/api/auth/staff-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ employee_id: (req.body || {}).employee_id, password: (req.body || {}).password })
    });
    return await sendSystemResponse(res, r);
  } catch (err) {
    res.status(502).json({ error: 'Failed to reach Student Records', details: err.message });
  }
});

// Health check — reads from DB
app.get('/hub/status', async (req, res) => {
  try {
    const registry = await getRegistry();
    const results = {};
    for (const [key, system] of Object.entries(registry)) {
      if (!system.baseUrl) {
        results[key] = { name: system.name, status: 'not-configured', error: 'URL not set yet' };
        continue;
      }
      try {
        const start = Date.now();
        const r = await fetchFromSystem(key, `${system.baseUrl.replace(/\/$/, '')}/api/db-check`);
        const ms = Date.now() - start;
        results[key] = { name: system.name, status: r.ok ? 'up' : 'down', responseTimeMs: ms };
      } catch (err) {
        const missingKey = err.message.endsWith('is not configured');
        results[key] = { name: system.name, status: missingKey ? 'not-configured' : 'down', error: err.message };
      }
    }
    return res.json(results);
  } catch (err) {
    console.error('Hub status check failed:', err.message);
    return res.status(503).json({ error: 'Unable to read registered systems from the Hub database' });
  }
});

// Admin access uses a server-side password and proxies partner API calls.
app.post('/hub/admin/login', async (req, res) => {
  const { ADMIN_USERNAME, ADMIN_PASSWORD, ADMIN_AUTH_SECRET } = process.env;
  if (ADMIN_USERNAME && ADMIN_PASSWORD && ADMIN_AUTH_SECRET && ADMIN_AUTH_SECRET.length >= 32) {
    const username = Buffer.from(String((req.body || {}).username || ''));
    const password = Buffer.from(String((req.body || {}).password || ''));
    const expectedUsername = Buffer.from(ADMIN_USERNAME);
    const expectedPassword = Buffer.from(ADMIN_PASSWORD);
    const usernameMatches = username.length === expectedUsername.length && crypto.timingSafeEqual(username, expectedUsername);
    const passwordMatches = password.length === expectedPassword.length && crypto.timingSafeEqual(password, expectedPassword);
    if (!usernameMatches || !passwordMatches) return res.status(401).json({ error: 'Incorrect username or password' });
    const payload = Buffer.from(JSON.stringify({ sid: ADMIN_USERNAME, type: 'admin', exp: Date.now() + 8 * 60 * 60 * 1000 })).toString('base64url');
    const signature = crypto.createHmac('sha256', ADMIN_AUTH_SECRET).update(payload).digest('base64url');
    return res.json({ token: `${payload}.${signature}` });
  }

  const authSecret = process.env.STUDENT_RECORDS_AUTH_SECRET || process.env.AUTH_SECRET;
  const employeeId = String((req.body || {}).username || '').trim();
  const password = (req.body || {}).password;
  if (!authSecret || !employeeId || typeof password !== 'string' || !password) {
    return res.status(503).json({ error: 'Enter the employee ID and password for an existing admin account' });
  }
  try {
    const registry = await getRegistry();
    const studentRecords = registry['student-records'];
    if (!studentRecords) return res.status(503).json({ error: 'Student Records system not configured' });
    const response = await fetchFromSystem('student-records', `${studentRecords.baseUrl.replace(/\/$/, '')}/api/auth/staff-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ employee_id: employeeId, password })
    });
    const responseText = await response.text();
    let data;
    try { data = JSON.parse(responseText); } catch { return res.status(502).json({ error: 'Student Records returned a non-JSON login response' }); }
    if (!response.ok) return res.status(response.status).json(data);
    if (data.role !== 'admin') return res.status(403).json({ error: 'Administrator employee access required' });

    const payload = Buffer.from(JSON.stringify({
      sid: data.employee_id,
      name: data.full_name,
      type: 'admin',
      exp: Date.now() + 8 * 60 * 60 * 1000
    })).toString('base64url');
    const signature = crypto.createHmac('sha256', authSecret).update(payload).digest('base64url');
    return res.json({ token: `${payload}.${signature}` });
  } catch (err) {
    return res.status(502).json({ error: 'Failed to reach Student Records', details: err.message });
  }
});

app.post('/hub/admin/students', requireAdmin, async (req, res) => {
  const { student_id, full_name, password } = req.body || {};
  if (!student_id || !full_name || typeof password !== 'string' || password.length < 8) {
    return res.status(400).json({ error: 'Student ID, full name, and password (at least 8 characters) are required' });
  }
  let baseUrl;
  let studentCreated = false;
  try {
    const registry = await getRegistry();
    const system = registry['student-records'];
    if (!system) return res.status(503).json({ error: 'Student Records system not configured' });
    baseUrl = system.baseUrl.replace(/\/$/, '');

    const { password: initialPassword, ...studentProfile } = req.body;
    const created = await fetchFromSystem('student-records', `${baseUrl}/api/students`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(studentProfile)
    });
    if (!created.ok) return await sendSystemResponse(res, created);
    studentCreated = true;

    const passwordSet = await fetchFromSystem('student-records', `${baseUrl}/api/auth/set-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ student_id, password: initialPassword })
    });
    if (!passwordSet.ok) {
      await fetchFromSystem('student-records', `${baseUrl}/api/students/${encodeURIComponent(student_id)}`, { method: 'DELETE' }).catch(() => {});
      studentCreated = false;
      return await sendSystemResponse(res, passwordSet);
    }

    studentCreated = false;
    return res.status(201).json({ ok: true, student_id });
  } catch (err) {
    if (studentCreated && baseUrl) {
      await fetchFromSystem('student-records', `${baseUrl}/api/students/${encodeURIComponent(student_id)}`, { method: 'DELETE' }).catch(() => {});
    }
    return res.status(502).json({ error: 'Failed to create student in Student Records', details: err.message });
  }
});

app.get('/hub/admin/students', requireAdmin, async (req, res) => {
  try {
    return await proxySystemRequest(res, 'student-records', '/api/students');
  } catch (err) {
    return res.status(502).json({ error: 'Failed to reach Student Records', details: err.message });
  }
});

app.get('/hub/admin/students/:id/profile', requireAdmin, async (req, res) => {
  try {
    return await proxySystemRequest(res, 'student-records', `/api/students/${encodeURIComponent(req.params.id)}/profile`);
  } catch (err) {
    return res.status(502).json({ error: 'Failed to reach Student Records', details: err.message });
  }
});

app.get('/hub/admin/students/:id/grades', requireAdmin, async (req, res) => {
  try {
    return await proxySystemRequest(res, 'student-records', `/api/students/${encodeURIComponent(req.params.id)}/grades`);
  } catch (err) {
    return res.status(502).json({ error: 'Failed to reach Student Records', details: err.message });
  }
});

app.get('/hub/admin/employees', requireAdmin, async (req, res) => {
  try {
    const registry = await getRegistry();
    const system = registry['student-records'];
    if (!system) return res.status(503).json({ error: 'Student Records system not configured' });
    const response = await fetchFromSystem('student-records', `${system.baseUrl.replace(/\/$/, '')}/api/employees`);
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { return res.status(response.status).json({ error: 'Student Records returned a non-JSON response' }); }
    if (!response.ok || !Array.isArray(data)) return res.status(response.status).json(data);
    return res.status(response.status).json(data.map(employee => {
      const { password, password_hash: passwordHash, ...safeEmployee } = employee;
      return { ...safeEmployee, has_password: Boolean(passwordHash || employee.has_password) };
    }));
  } catch (err) {
    return res.status(502).json({ error: 'Failed to reach Student Records', details: err.message });
  }
});

app.post('/hub/admin/employees', requireAdmin, async (req, res) => {
  const { employee_id, full_name, role, password } = req.body || {};
  if (!employee_id || !full_name || !['admin', 'staff'].includes(role) || typeof password !== 'string' || password.length < 8) {
    return res.status(400).json({ error: 'Valid employee_id, full_name, role, and password (at least 8 characters) are required' });
  }
  let baseUrl;
  let employeeCreated = false;
  try {
    const registry = await getRegistry();
    const system = registry['student-records'];
    if (!system) return res.status(503).json({ error: 'Student Records system not configured' });
    baseUrl = system.baseUrl.replace(/\/$/, '');
    const created = await fetchFromSystem('student-records', `${baseUrl}/api/employees`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ employee_id, full_name, role })
    });
    if (!created.ok) return await sendSystemResponse(res, created);
    employeeCreated = true;
    const passwordSet = await fetchFromSystem('student-records', `${baseUrl}/api/auth/set-staff-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ employee_id, password })
    });
    if (!passwordSet.ok) {
      await fetchFromSystem('student-records', `${baseUrl}/api/employees/${encodeURIComponent(employee_id)}`, { method: 'DELETE' }).catch(() => {});
      employeeCreated = false;
      return await sendSystemResponse(res, passwordSet);
    }
    employeeCreated = false;
    return await sendSystemResponse(res, passwordSet);
  } catch (err) {
    if (employeeCreated && baseUrl) {
      await fetchFromSystem('student-records', `${baseUrl}/api/employees/${encodeURIComponent(employee_id)}`, { method: 'DELETE' }).catch(() => {});
    }
    return res.status(502).json({ error: 'Failed to update employees in Student Records', details: err.message });
  }
});

app.post('/hub/admin/employees/:id/password', requireAdmin, async (req, res) => {
  const { password } = req.body || {};
  if (typeof password !== 'string' || password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }
  try {
    return await proxySystemRequest(res, 'student-records', '/api/auth/set-staff-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ employee_id: req.params.id, password })
    });
  } catch (err) {
    return res.status(502).json({ error: 'Failed to reset employee password', details: err.message });
  }
});

app.delete('/hub/admin/employees/:id', requireAdmin, async (req, res) => {
  try {
    return await proxySystemRequest(res, 'student-records', `/api/employees/${encodeURIComponent(req.params.id)}`, { method: 'DELETE' });
  } catch (err) {
    return res.status(502).json({ error: 'Failed to delete employee', details: err.message });
  }
});

// Student search
app.get('/hub/students/search', requireEmployee, async (req, res) => {
  const q = req.query.q;
  if (!q || !q.trim()) return res.status(400).json({ error: 'Query parameter q is required' });
  try {
    const registry = await getRegistry();
    const sr = registry['student-records'];
    const r = await fetchFromSystem('student-records', `${sr.baseUrl}/api/students?search=${encodeURIComponent(q)}`);
    return await sendSystemResponse(res, r);
  } catch (err) {
    res.status(502).json({ error: 'Failed to reach Student Records', details: err.message });
  }
});

app.get('/hub/students/:id', requireOwnRecord, async (req, res) => {
  try {
    const registry = await getRegistry();
    const sr = registry['student-records'];
    const r = await fetchFromSystem('student-records', `${sr.baseUrl}/api/students/${encodeURIComponent(req.params.id)}/profile`);
    return await sendSystemResponse(res, r);
  } catch (err) {
    res.status(502).json({ error: 'Failed to reach Student Records', details: err.message });
  }
});

app.get('/hub/students/:id/grades', requireOwnRecord, async (req, res) => {
  try {
    const registry = await getRegistry();
    const sr = registry['student-records'];
    const r = await fetchFromSystem('student-records', `${sr.baseUrl}/api/students/${encodeURIComponent(req.params.id)}/grades`);
    return await sendSystemResponse(res, r);
  } catch (err) {
    res.status(502).json({ error: 'Failed to reach Student Records', details: err.message });
  }
});

app.get('/hub/students/:id/enrollment', requireOwnRecord, async (req, res) => {
  const registry = await getRegistry();
  const sys = registry['enrollment'];
  if (!sys) return res.status(503).json({ error: 'Enrollment system not configured yet' });
  try {
    const r = await fetchFromSystem('enrollment', `${sys.baseUrl}/api/students/${encodeURIComponent(req.params.id)}/schedule`);
    return await sendSystemResponse(res, r);
  } catch (err) {
    res.status(502).json({ error: 'Failed to reach Enrollment system', details: err.message });
  }
});

app.get('/hub/students/:id/finance', requireOwnRecord, async (req, res) => {
  const registry = await getRegistry();
  const sys = registry['finance'];
  if (!sys) return res.status(503).json({ error: 'Finance system not configured yet' });
  try {
    const r = await fetchFromSystem('finance', `${sys.baseUrl.replace(/\/$/, '')}/api/transactions/balance/${encodeURIComponent(req.params.id)}`);
    return await sendSystemResponse(res, r);
  } catch (err) {
    res.status(502).json({ error: 'Failed to reach Finance system', details: err.message });
  }
});

app.get('/hub/students/:id/lms', requireOwnRecord, async (req, res) => {
  const registry = await getRegistry();
  const sys = registry['lms'];
  if (!sys) return res.status(503).json({ error: 'LMS system not configured yet' });
  try {
    const r = await fetchFromSystem('lms', `${sys.baseUrl}/api/students/${encodeURIComponent(req.params.id)}/courses`);
    return await sendSystemResponse(res, r);
  } catch (err) {
    res.status(502).json({ error: 'Failed to reach LMS system', details: err.message });
  }
});

// Full bundle — login required
app.get('/hub/students/:id/full', requireOwnRecord, async (req, res) => {
  const id = req.params.id;
  const registry = await getRegistry();
  const srBase = registry['student-records']?.baseUrl;

  const safe = async (fn) => {
    try { return { ok: true, data: await fn() }; }
    catch (e) { return { ok: false, error: e.message }; }
  };
  const fetchJSON = async (systemKey, url, headers = {}) => {
    const r = await fetchFromSystem(systemKey, url, { headers });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const contentType = r.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) throw new Error(`HTTP ${r.status}: non-JSON response`);
    return r.json();
  };

  const enrollment = registry['enrollment'];
  const finance = registry['finance'];
  const lms = registry['lms'];

  const [profile, grades, enrollmentData, financeData, lmsData] = await Promise.all([
    safe(() => fetchJSON('student-records', `${srBase}/api/students/${encodeURIComponent(id)}/profile`)),
    safe(() => fetchJSON('student-records', `${srBase}/api/students/${encodeURIComponent(id)}/grades`)),
    enrollment ? safe(() => fetchJSON('enrollment', `${enrollment.baseUrl}/api/students/${encodeURIComponent(id)}/schedule`)) : { ok: false, error: 'not-configured' },
    finance ? safe(() => fetchJSON('finance', `${finance.baseUrl.replace(/\/$/, '')}/api/transactions/balance/${encodeURIComponent(id)}`)) : { ok: false, error: 'not-configured' },
    lms ? safe(() => fetchJSON('lms', `${lms.baseUrl}/api/students/${encodeURIComponent(id)}/courses`)) : { ok: false, error: 'not-configured' },
  ]);

  if (!profile.ok) return res.status(404).json({ error: 'Student not found or Student Records offline' });

  res.json({
    profile: profile.data,
    grades: grades.ok ? grades.data : [],
    gradesError: grades.ok ? null : grades.error,
    enrollment: enrollmentData.ok ? enrollmentData.data : null,
    enrollmentError: enrollmentData.ok ? null : enrollmentData.error,
    finance: financeData.ok ? financeData.data : null,
    financeError: financeData.ok ? null : financeData.error,
    lms: lmsData.ok ? lmsData.data : null,
    lmsError: lmsData.ok ? null : lmsData.error,
  });
});

const PORT = process.env.PORT || 4000;

async function startServer() {
  if (!process.env.HUB_DATABASE_URL && !process.env.DATABASE_URL) {
    throw new Error('HUB_DATABASE_URL is required (or set DATABASE_URL to the IT-department-hub database)');
  }
  await pool.query(`CREATE TABLE IF NOT EXISTS systems (
    key TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    base_url TEXT NOT NULL,
    registered_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  if (studentRecordsPool) await initializeStudentRecordsDatabase(studentRecordsPool);
  else console.warn('Student Records replacement is disabled: STUDENT_RECORDS_DATABASE_URL is not configured');
  app.listen(PORT, () => console.log(`Central Hub running on port ${PORT}`));
}

if (require.main === module) {
  startServer().catch(error => {
    console.error('Hub database initialization failed:', error.message);
    process.exitCode = 1;
  });
}

module.exports = { app, pool, startServer };