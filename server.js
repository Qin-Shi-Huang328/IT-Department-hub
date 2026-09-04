require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json());

// Registry of known systems in the ecosystem.
// Add real URLs here as other groups deploy their services.
const REGISTRY = {
  'student-records': {
    name: 'Student Records',
    baseUrl: 'https://student-records-api-6qqj.onrender.com'
  }
  // 'admission': { name: 'Admission Management', baseUrl: '' },
  // 'enrollment': { name: 'Enrollment System', baseUrl: '' },
  // 'finance': { name: 'Finance/Transaction', baseUrl: '' },
  // 'portal': { name: 'LMS/Web Portal', baseUrl: '' },
};

app.get('/', (req, res) => {
  res.json({ message: 'Central Hub is running', systems: Object.keys(REGISTRY) });
});

// Health check: pings every registered system and reports up/down
app.get('/hub/status', async (req, res) => {
  const results = {};
  for (const [key, system] of Object.entries(REGISTRY)) {
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

// Proxy: get a student's profile through the Hub
app.get('/hub/students/:id', async (req, res) => {
  try {
    const r = await fetch(`${REGISTRY['student-records'].baseUrl}/api/students/${req.params.id}/profile`);
    const data = await r.json();
    res.status(r.status).json(data);
  } catch (err) {
    res.status(502).json({ error: 'Failed to reach Student Records system', details: err.message });
  }
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Central Hub running on port ${PORT}`));