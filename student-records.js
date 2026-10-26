const crypto = require('node:crypto');
const express = require('express');
const { promisify } = require('node:util');

const scrypt = promisify(crypto.scrypt);

async function initializeStudentRecordsDatabase(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS students (
    student_id TEXT PRIMARY KEY,
    full_name TEXT NOT NULL,
    year_level TEXT,
    section TEXT,
    email TEXT,
    contact_number TEXT,
    address TEXT,
    enrollment_status TEXT NOT NULL DEFAULT 'not-enrolled',
    password_hash TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS grades (
    id BIGSERIAL PRIMARY KEY,
    student_id TEXT NOT NULL REFERENCES students(student_id) ON DELETE CASCADE,
    subject_code TEXT,
    subject_name TEXT,
    school_year TEXT,
    semester TEXT,
    grade TEXT,
    remarks TEXT
  )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS grades_student_id_idx ON grades(student_id)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS employees (
    employee_id TEXT PRIMARY KEY,
    full_name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin', 'staff')),
    password_hash TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
}

function createStudentRecordsRouter({ pool, getApiKey, getAuthSecret }) {
  const router = express.Router();

  function requireApiKey(req, res, next) {
    const expected = getApiKey();
    const actual = req.header('x-api-key') || '';
    if (!expected) return res.status(503).json({ error: 'Student Records API key is not configured' });
    const expectedBuffer = Buffer.from(expected);
    const actualBuffer = Buffer.from(actual);
    if (actualBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(actualBuffer, expectedBuffer)) {
      return res.status(401).json({ error: 'Missing or invalid API key' });
    }
    next();
  }

  async function hashPassword(password) {
    const salt = crypto.randomBytes(16).toString('hex');
    const key = await scrypt(password, salt, 64);
    return `${salt}:${key.toString('hex')}`;
  }

  async function verifyPassword(password, stored) {
    if (typeof stored !== 'string') return false;
    const [salt, hash] = stored.split(':');
    if (!/^[a-f0-9]{32}$/i.test(salt || '') || !/^[a-f0-9]{128}$/i.test(hash || '')) return false;
    const expected = Buffer.from(hash, 'hex');
    const actual = await scrypt(password, salt, expected.length);
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  }

  function createToken(sid, type) {
    const authSecret = getAuthSecret();
    if (!authSecret) throw new Error('Student Records authentication secret is not configured');
    const payload = Buffer.from(JSON.stringify({ sid, type, exp: Date.now() + 8 * 60 * 60 * 1000 })).toString('base64url');
    const signature = crypto.createHmac('sha256', authSecret).update(payload).digest('base64url');
    return `${payload}.${signature}`;
  }

  router.use(requireApiKey);

  router.get('/db-check', async (req, res) => {
    if (!pool) return res.status(503).json({ error: 'Student Records database is not configured' });
    try {
      await pool.query('SELECT 1');
      return res.json({ ok: true, system: 'student-records' });
    } catch {
      return res.status(503).json({ error: 'Student Records database is unavailable' });
    }
  });

  router.post('/auth/login', async (req, res) => {
    if (!pool) return res.status(503).json({ error: 'Student Records database is not configured' });
    const { student_id: studentId, password } = req.body || {};
    if (!studentId || typeof password !== 'string') return res.status(400).json({ error: 'Student number and password are required' });
    try {
      const result = await pool.query('SELECT student_id, password_hash FROM students WHERE student_id = $1', [studentId]);
      if (!result.rows[0] || !(await verifyPassword(password, result.rows[0].password_hash))) {
        return res.status(401).json({ error: 'Incorrect student number or password' });
      }
      return res.json({ token: createToken(result.rows[0].student_id, 'student'), student_id: result.rows[0].student_id });
    } catch (error) {
      return res.status(500).json({ error: 'Student sign-in failed' });
    }
  });

  router.post('/auth/staff-login', async (req, res) => {
    if (!pool) return res.status(503).json({ error: 'Student Records database is not configured' });
    const { employee_id: employeeId, password } = req.body || {};
    if (!employeeId || typeof password !== 'string') return res.status(400).json({ error: 'Employee ID and password are required' });
    try {
      const result = await pool.query('SELECT employee_id, full_name, password_hash FROM employees WHERE employee_id = $1', [employeeId]);
      const employee = result.rows[0];
      if (!employee || !(await verifyPassword(password, employee.password_hash))) {
        return res.status(401).json({ error: 'Incorrect employee ID or password' });
      }
      return res.json({
        token: createToken(employee.employee_id, 'employee'),
        employee_id: employee.employee_id,
        full_name: employee.full_name
      });
    } catch {
      return res.status(500).json({ error: 'Employee sign-in failed' });
    }
  });

  router.get('/students', async (req, res) => {
    if (!pool) return res.status(503).json({ error: 'Student Records database is not configured' });
    const search = String(req.query.search || '').trim();
    try {
      const result = await pool.query(
        `SELECT student_id, full_name, year_level, section, enrollment_status
         FROM students
         WHERE $1 = '' OR student_id ILIKE '%' || $1 || '%' OR full_name ILIKE '%' || $1 || '%'
         ORDER BY full_name`,
        [search]
      );
      return res.json(result.rows);
    } catch {
      return res.status(500).json({ error: 'Could not load students' });
    }
  });

  router.get('/students/:id/profile', async (req, res) => {
    if (!pool) return res.status(503).json({ error: 'Student Records database is not configured' });
    try {
      const result = await pool.query(
        `SELECT student_id, full_name, year_level, section, email, contact_number, address, enrollment_status
         FROM students WHERE student_id = $1`,
        [req.params.id]
      );
      if (!result.rows[0]) return res.status(404).json({ error: 'Student not found' });
      return res.json(result.rows[0]);
    } catch {
      return res.status(500).json({ error: 'Could not load student profile' });
    }
  });

  router.get('/students/:id/grades', async (req, res) => {
    if (!pool) return res.status(503).json({ error: 'Student Records database is not configured' });
    try {
      const result = await pool.query(
        `SELECT subject_code, subject_name, school_year, semester, grade, remarks
         FROM grades WHERE student_id = $1 ORDER BY school_year DESC, semester, subject_code`,
        [req.params.id]
      );
      return res.json(result.rows);
    } catch {
      return res.status(500).json({ error: 'Could not load student grades' });
    }
  });

  router.put('/students/:id/grades', async (req, res) => {
    if (!pool) return res.status(503).json({ error: 'Student Records database is not configured' });
    const grades = req.body;
    if (!Array.isArray(grades) || grades.length > 500) {
      return res.status(400).json({ error: 'Request must contain an array of at most 500 grades' });
    }
    const normalizedGrades = [];
    for (const grade of grades) {
      if (!grade || typeof grade !== 'object' || Array.isArray(grade) ||
          typeof grade.subject_code !== 'string' || !grade.subject_code.trim() ||
          typeof grade.subject_name !== 'string' || !grade.subject_name.trim()) {
        return res.status(400).json({ error: 'Every grade must include subject_code and subject_name' });
      }
      const fields = ['school_year', 'semester', 'grade', 'remarks'];
      if (fields.some(field => grade[field] !== undefined && grade[field] !== null &&
          typeof grade[field] !== 'string' && typeof grade[field] !== 'number')) {
        return res.status(400).json({ error: 'Grade fields must be strings or numbers' });
      }
      normalizedGrades.push([
        grade.subject_code.trim(), grade.subject_name.trim(),
        grade.school_year == null ? null : String(grade.school_year),
        grade.semester == null ? null : String(grade.semester),
        grade.grade == null ? null : String(grade.grade),
        grade.remarks == null ? null : String(grade.remarks)
      ]);
    }

    let client;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      const student = await client.query('SELECT student_id FROM students WHERE student_id = $1 FOR UPDATE', [req.params.id]);
      if (!student.rows[0]) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Student not found' });
      }
      await client.query('DELETE FROM grades WHERE student_id = $1', [req.params.id]);
      for (const grade of normalizedGrades) {
        await client.query(
          `INSERT INTO grades (student_id, subject_code, subject_name, school_year, semester, grade, remarks)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [req.params.id, ...grade]
        );
      }
      await client.query('COMMIT');
      return res.json({ ok: true, student_id: req.params.id, imported: normalizedGrades.length });
    } catch {
      if (client) await client.query('ROLLBACK').catch(() => {});
      return res.status(500).json({ error: 'Could not import student grades' });
    } finally {
      if (client) client.release();
    }
  });

  router.get('/employees', async (req, res) => {
    if (!pool) return res.status(503).json({ error: 'Student Records database is not configured' });
    try {
      const result = await pool.query(
        `SELECT employee_id, full_name, role, password_hash IS NOT NULL AS has_password
         FROM employees ORDER BY full_name`
      );
      return res.json(result.rows);
    } catch {
      return res.status(500).json({ error: 'Could not load employees' });
    }
  });

  router.post('/students', async (req, res) => {
    if (!pool) return res.status(503).json({ error: 'Student Records database is not configured' });
    const { student_id: studentId, full_name: fullName, password } = req.body || {};
    const enrollmentStatus = req.body.enrollment_status || 'not-enrolled';
    if (typeof studentId !== 'string' || !studentId.trim() || typeof fullName !== 'string' || !fullName.trim() ||
        typeof password !== 'string' || password.length < 8 ||
        !['enrolled', 'not-enrolled', 'irregular'].includes(enrollmentStatus)) {
      return res.status(400).json({ error: 'Student ID, full name, and password (at least 8 characters) are required' });
    }
    try {
      const passwordHash = await hashPassword(password);
      await pool.query(
        `INSERT INTO students (student_id, full_name, year_level, section, email, contact_number, address, enrollment_status, password_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [studentId.trim(), fullName.trim(), req.body.year_level || null, req.body.section || null, req.body.email || null,
          req.body.contact_number || null, req.body.address || null, enrollmentStatus, passwordHash]
      );
      return res.status(201).json({ ok: true, student_id: studentId });
    } catch (error) {
      if (error.code === '23505') return res.status(409).json({ error: 'Student ID already exists' });
      return res.status(500).json({ error: 'Could not create student' });
    }
  });

  router.post('/employees', async (req, res) => {
    if (!pool) return res.status(503).json({ error: 'Student Records database is not configured' });
    const { employee_id: employeeId, full_name: fullName, role } = req.body || {};
    if (!employeeId || !fullName || !['admin', 'staff'].includes(role)) {
      return res.status(400).json({ error: 'Employee ID, full name, and valid role are required' });
    }
    try {
      await pool.query('INSERT INTO employees (employee_id, full_name, role) VALUES ($1, $2, $3)', [employeeId, fullName, role]);
      return res.status(201).json({ ok: true, employee_id: employeeId });
    } catch (error) {
      if (error.code === '23505') return res.status(409).json({ error: 'Employee ID already exists' });
      return res.status(500).json({ error: 'Could not create employee' });
    }
  });

  router.post('/auth/set-staff-password', async (req, res) => {
    if (!pool) return res.status(503).json({ error: 'Student Records database is not configured' });
    const { employee_id: employeeId, password } = req.body || {};
    if (!employeeId || typeof password !== 'string' || password.length < 8) {
      return res.status(400).json({ error: 'Employee ID and password (at least 8 characters) are required' });
    }
    try {
      const passwordHash = await hashPassword(password);
      const result = await pool.query('UPDATE employees SET password_hash = $2 WHERE employee_id = $1', [employeeId, passwordHash]);
      if (result.rowCount === 0) return res.status(404).json({ error: 'Employee not found' });
      return res.json({ ok: true });
    } catch {
      return res.status(500).json({ error: 'Could not set employee password' });
    }
  });

  router.delete('/employees/:id', async (req, res) => {
    if (!pool) return res.status(503).json({ error: 'Student Records database is not configured' });
    try {
      const target = await pool.query('SELECT role FROM employees WHERE employee_id = $1', [req.params.id]);
      if (!target.rows[0]) return res.status(404).json({ error: 'Employee not found' });
      if (target.rows[0].role === 'admin') {
        const admins = await pool.query("SELECT COUNT(*)::int AS count FROM employees WHERE role = 'admin'");
        if (admins.rows[0].count <= 1) return res.status(409).json({ error: 'Cannot delete the last admin account' });
      }
      await pool.query('DELETE FROM employees WHERE employee_id = $1', [req.params.id]);
      return res.json({ ok: true });
    } catch {
      return res.status(500).json({ error: 'Could not delete employee' });
    }
  });

  return router;
}

module.exports = { createStudentRecordsRouter, initializeStudentRecordsDatabase };