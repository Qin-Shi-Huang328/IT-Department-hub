require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const fetch = require('node-fetch');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

function requireApiKey(req, res, next) {
  const key = req.header('x-api-key');
  if (!key || key !== process.env.API_KEY) {
    return res.status(401).json({ error: 'Missing or invalid API key' });
  }
  next();
}

async function getRegistry() {
  const result = await pool.query('SELECT key, name, base_url FROM systems');
  const registry = {};
  for (const row of result.rows) {
    registry[row.key] = { name: row.name, baseUrl: row.base_url };
  }
  return registry;
}

function verifyToken(token) {
  if (!token || !process.env.AUTH_SECRET) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payload, sig] = parts;
  const expected = crypto.createHmac('sha256', process.env.AUTH_SECRET).update(payload).digest('base64url');
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

app.get('/dashboard', (req, res) => res.sendFile(require('path').join(__dirname, 'user-dashboard.html')));

app.get('/', (req, res) => {
  res.json({ message: 'Central Hub is running' });
});

// Self-registration endpoint
app.post('/hub/register', requireApiKey, async (req, res) => {
  const { key, name, base_url } = req.body;
  if (!key || !name || !base_url) {
    return res.status(400).json({ error: 'key, name, and base_url are required' });
  }
  try {
    // Test their URL first
    const test = await fetch(`${base_url}/api/db-check`);
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
    const r = await fetch(`${sr.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ student_id: (req.body || {}).student_id, password: (req.body || {}).password })
    });
    const data = await r.json();
    res.status(r.status).json(data);
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
    const r = await fetch(`${sr.baseUrl}/api/auth/staff-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ employee_id: (req.body || {}).employee_id, password: (req.body || {}).password })
    });
    const data = await r.json();
    res.status(r.status).json(data);
  } catch (err) {
    res.status(502).json({ error: 'Failed to reach Student Records', details: err.message });
  }
});

// Health check — reads from DB
app.get('/hub/status', async (req, res) => {
  const registry = await getRegistry();
  const results = {};
  for (const [key, system] of Object.entries(registry)) {
    if (!system.baseUrl) {
      results[key] = { name: system.name, status: 'not-configured', error: 'URL not set yet' };
      continue;
    }
    try {
      const start = Date.now();
      const r = await fetch(`${system.baseUrl}/api/db-check`);
      const ms = Date.now() - start;
      results[key] = { name: system.name, status: r.ok ? 'up' : 'down', responseTimeMs: ms };
    } catch (err) {
      results[key] = { name: system.name, status: 'down', error: err.message };
    }
  }
  res.json(results);
});

// Student search
app.get('/hub/students/search', async (req, res) => {
  const q = req.query.q;
  if (!q || !q.trim()) return res.status(400).json({ error: 'Query parameter q is required' });
  try {
    const registry = await getRegistry();
    const sr = registry['student-records'];
    const r = await fetch(`${sr.baseUrl}/api/students?search=${encodeURIComponent(q)}`);
    const data = await r.json();
    res.status(r.status).json(data);
  } catch (err) {
    res.status(502).json({ error: 'Failed to reach Student Records', details: err.message });
  }
});

app.get('/hub/students/:id', async (req, res) => {
  try {
    const registry = await getRegistry();
    const sr = registry['student-records'];
    const r = await fetch(`${sr.baseUrl}/api/students/${req.params.id}/profile`);
    const data = await r.json();
    res.status(r.status).json(data);
  } catch (err) {
    res.status(502).json({ error: 'Failed to reach Student Records', details: err.message });
  }
});

app.get('/hub/students/:id/grades', async (req, res) => {
  try {
    const registry = await getRegistry();
    const sr = registry['student-records'];
    const r = await fetch(`${sr.baseUrl}/api/students/${req.params.id}/grades`);
    const data = await r.json();
    res.status(r.status).json(data);
  } catch (err) {
    res.status(502).json({ error: 'Failed to reach Student Records', details: err.message });
  }
});

app.get('/hub/students/:id/enrollment', async (req, res) => {
  const registry = await getRegistry();
  const sys = registry['enrollment'];
  if (!sys) return res.status(503).json({ error: 'Enrollment system not configured yet' });
  try {
    const r = await fetch(`${sys.baseUrl}/api/students/${req.params.id}/schedule`, {
      headers: { 'x-api-key': 'csfj-hub-secret-2026' }
    });
    const data = await r.json();
    res.status(r.status).json(data);
  } catch (err) {
    res.status(502).json({ error: 'Failed to reach Enrollment system', details: err.message });
  }
});

app.get('/hub/students/:id/finance', async (req, res) => {
  const registry = await getRegistry();
  const sys = registry['finance'];
  if (!sys) return res.status(503).json({ error: 'Finance system not configured yet' });
  try {
    const r = await fetch(`${sys.baseUrl}/api/students/${req.params.id}/balance`);
    const data = await r.json();
    res.status(r.status).json(data);
  } catch (err) {
    res.status(502).json({ error: 'Failed to reach Finance system', details: err.message });
  }
});

app.get('/hub/students/:id/lms', async (req, res) => {
  const registry = await getRegistry();
  const sys = registry['lms'];
  if (!sys) return res.status(503).json({ error: 'LMS system not configured yet' });
  try {
    const r = await fetch(`${sys.baseUrl}/api/students/${req.params.id}/courses`);
    const data = await r.json();
    res.status(r.status).json(data);
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
  const fetchJSON = async (url, headers = {}) => {
    const r = await fetch(url, { headers });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  };

  const enrollment = registry['enrollment'];
  const finance = registry['finance'];
  const lms = registry['lms'];

  const [profile, grades, enrollmentData, financeData, lmsData] = await Promise.all([
    safe(() => fetchJSON(`${srBase}/api/students/${id}/profile`)),
    safe(() => fetchJSON(`${srBase}/api/students/${id}/grades`)),
    enrollment ? safe(() => fetchJSON(`${enrollment.baseUrl}/api/students/${id}/schedule`, { 'x-api-key': 'csfj-hub-secret-2026' })) : { ok: false, error: 'not-configured' },
    finance ? safe(() => fetchJSON(`${finance.baseUrl}/api/students/${id}/balance`)) : { ok: false, error: 'not-configured' },
    lms ? safe(() => fetchJSON(`${lms.baseUrl}/api/students/${id}/courses`)) : { ok: false, error: 'not-configured' },
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
app.listen(PORT, () => console.log(`Central Hub running on port ${PORT}`));