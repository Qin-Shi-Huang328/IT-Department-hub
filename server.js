require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json());

const REGISTRY = {
  'student-records': {
    name: 'Student Records',
    baseUrl: 'https://student-records-api-6qqj.onrender.com'
  },
  'enrollment': {
    name: 'Enrollment System',
    baseUrl: '' // Fill in once that group deploys
  },
  'finance': {
    name: 'Finance / Transaction',
    baseUrl: '' // Fill in once that group deploys
  },
  'lms': {
    name: 'LMS / Web Portal',
    baseUrl: '' // Fill in once that group deploys
  },
};

// ── Login token check (token is made by Student Records /api/auth/login) ─────
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

// Only the logged-in student can open their own record
function requireOwnRecord(req, res, next) {
  const auth = req.header('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const data = verifyToken(token);
  if (!data) return res.status(401).json({ error: 'Please log in again' });
  if (data.sid !== req.params.id) return res.status(403).json({ error: 'You can only view your own record' });
  next();
}

app.get('/', (req, res) => {
  res.json({ message: 'Central Hub is running', systems: Object.keys(REGISTRY) });
});

// ── Student login (forwards to Student Records) ──────────────────────────────
app.post('/hub/login', async (req, res) => {
  try {
    const r = await fetch(`${REGISTRY['student-records'].baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        student_id: (req.body || {}).student_id,
        password: (req.body || {}).password
      })
    });
    const data = await r.json();
    res.status(r.status).json(data);
  } catch (err) {
    res.status(502).json({ error: 'Failed to reach Student Records', details: err.message });
  }
});

// ── Health check ─────────────────────────────────────────────────────────────
app.get('/hub/status', async (req, res) => {
  const results = {};
  for (const [key, system] of Object.entries(REGISTRY)) {
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

// ── Student Records proxies ───────────────────────────────────────────────────
app.get('/hub/students/search', async (req, res) => {
  const q = req.query.q;
  if (!q || !q.trim()) return res.status(400).json({ error: 'Query parameter q is required' });
  try {
    const r = await fetch(`${REGISTRY['student-records'].baseUrl}/api/students?search=${encodeURIComponent(q)}`);
    const data = await r.json();
    res.status(r.status).json(data);
  } catch (err) {
    res.status(502).json({ error: 'Failed to reach Student Records', details: err.message });
  }
});

app.get('/hub/students/:id', async (req, res) => {
  try {
    const r = await fetch(`${REGISTRY['student-records'].baseUrl}/api/students/${req.params.id}/profile`);
    const data = await r.json();
    res.status(r.status).json(data);
  } catch (err) {
    res.status(502).json({ error: 'Failed to reach Student Records', details: err.message });
  }
});

app.get('/hub/students/:id/grades', async (req, res) => {
  try {
    const r = await fetch(`${REGISTRY['student-records'].baseUrl}/api/students/${req.params.id}/grades`);
    const data = await r.json();
    res.status(r.status).json(data);
  } catch (err) {
    res.status(502).json({ error: 'Failed to reach Student Records', details: err.message });
  }
});

// ── Enrollment proxies ────────────────────────────────────────────────────────
// Expected from Enrollment group: GET /api/students/:id/schedule
// Returns: [{ subject_code, subject_name, schedule, room, instructor }]
app.get('/hub/students/:id/enrollment', async (req, res) => {
  if (!REGISTRY['enrollment'].baseUrl) {
    return res.status(503).json({ error: 'Enrollment system not configured yet' });
  }
  try {
    const r = await fetch(`${REGISTRY['enrollment'].baseUrl}/api/students/${req.params.id}/schedule`);
    const data = await r.json();
    res.status(r.status).json(data);
  } catch (err) {
    res.status(502).json({ error: 'Failed to reach Enrollment system', details: err.message });
  }
});

// ── Finance proxies ───────────────────────────────────────────────────────────
// Expected from Finance group: GET /api/students/:id/balance
// Returns: { total_fees, total_paid, balance, transactions: [...] }
app.get('/hub/students/:id/finance', async (req, res) => {
  if (!REGISTRY['finance'].baseUrl) {
    return res.status(503).json({ error: 'Finance system not configured yet' });
  }
  try {
    const r = await fetch(`${REGISTRY['finance'].baseUrl}/api/students/${req.params.id}/balance`);
    const data = await r.json();
    res.status(r.status).json(data);
  } catch (err) {
    res.status(502).json({ error: 'Failed to reach Finance system', details: err.message });
  }
});

// ── LMS proxies ───────────────────────────────────────────────────────────────
// Expected from LMS group: GET /api/students/:id/courses
// Returns: [{ course_code, course_name, instructor, progress_pct, lms_grade }]
app.get('/hub/students/:id/lms', async (req, res) => {
  if (!REGISTRY['lms'].baseUrl) {
    return res.status(503).json({ error: 'LMS system not configured yet' });
  }
  try {
    const r = await fetch(`${REGISTRY['lms'].baseUrl}/api/students/${req.params.id}/courses`);
    const data = await r.json();
    res.status(r.status).json(data);
  } catch (err) {
    res.status(502).json({ error: 'Failed to reach LMS system', details: err.message });
  }
});

// ── Full bundle: profile + all subsystems in one call (LOGIN REQUIRED) ───────
// The user dashboard calls this once to populate everything.
app.get('/hub/students/:id/full', requireOwnRecord, async (req, res) => {
  const id = req.params.id;
  const srBase = REGISTRY['student-records'].baseUrl;

  const safe = async (fn) => {
    try { return { ok: true, data: await fn() }; }
    catch (e) { return { ok: false, error: e.message }; }
  };

  const fetchJSON = async (url) => {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  };

  const [profile, grades, enrollment, finance, lms] = await Promise.all([
    safe(() => fetchJSON(`${srBase}/api/students/${id}/profile`)),
    safe(() => fetchJSON(`${srBase}/api/students/${id}/grades`)),
    REGISTRY['enrollment'].baseUrl
      ? safe(() => fetchJSON(`${REGISTRY['enrollment'].baseUrl}/api/students/${id}/schedule`))
      : { ok: false, error: 'not-configured' },
    REGISTRY['finance'].baseUrl
      ? safe(() => fetchJSON(`${REGISTRY['finance'].baseUrl}/api/students/${id}/balance`))
      : { ok: false, error: 'not-configured' },
    REGISTRY['lms'].baseUrl
      ? safe(() => fetchJSON(`${REGISTRY['lms'].baseUrl}/api/students/${id}/courses`))
      : { ok: false, error: 'not-configured' },
  ]);

  if (!profile.ok) return res.status(404).json({ error: 'Student not found or Student Records offline' });

  res.json({
    profile: profile.data,
    grades: grades.ok ? grades.data : [],
    gradesError: grades.ok ? null : grades.error,
    enrollment: enrollment.ok ? enrollment.data : null,
    enrollmentError: enrollment.ok ? null : enrollment.error,
    finance: finance.ok ? finance.data : null,
    financeError: finance.ok ? null : finance.error,
    lms: lms.ok ? lms.data : null,
    lmsError: lms.ok ? null : lms.error,
  });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Central Hub running on port ${PORT}`));