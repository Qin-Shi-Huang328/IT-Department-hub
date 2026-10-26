const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const { test } = require('node:test');
const { promisify } = require('node:util');
const { createStudentRecordsRouter, initializeStudentRecordsDatabase } = require('./student-records');

const scrypt = promisify(crypto.scrypt);

async function withServer(options, run) {
  const app = express();
  app.use(express.json());
  app.use('/api', createStudentRecordsRouter({
    getApiKey: () => 'test-api-key',
    getAuthSecret: () => 'test-auth-secret-that-is-long-enough',
    ...options
  }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

test('replacement API requires the configured API key', async () => {
  await withServer({ pool: { query: async () => ({ rows: [{}] }) } }, async baseUrl => {
    const response = await fetch(`${baseUrl}/api/db-check`);
    assert.equal(response.status, 401);
  });
});

test('replacement API health check uses its own database pool', async () => {
  let queryCalled = false;
  await withServer({ pool: { query: async () => { queryCalled = true; return { rows: [{ '?column?': 1 }] }; } } }, async baseUrl => {
    const response = await fetch(`${baseUrl}/api/db-check`, { headers: { 'x-api-key': 'test-api-key' } });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, system: 'student-records' });
  });
  assert.equal(queryCalled, true);
});

test('replacement API reports missing database configuration', async () => {
  await withServer({ pool: null }, async baseUrl => {
    const response = await fetch(`${baseUrl}/api/db-check`, { headers: { 'x-api-key': 'test-api-key' } });
    assert.equal(response.status, 503);
  });
});

test('student creation stores the existing Student Records scrypt format, not plaintext', async () => {
  let insertedValues;
  const pool = { query: async (query, values) => { insertedValues = values; return { rowCount: 1, rows: [] }; } };
  await withServer({ pool }, async baseUrl => {
    const response = await fetch(`${baseUrl}/api/students`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': 'test-api-key' },
      body: JSON.stringify({ student_id: 'TEST-1', full_name: 'Test Student', password: 'example-password' })
    });
    assert.equal(response.status, 201);
    assert.deepEqual(await response.json(), { ok: true, student_id: 'TEST-1' });
  });
  const storedHash = insertedValues[8];
  assert.match(storedHash, /^[a-f0-9]{32}:[a-f0-9]{128}$/i);
  assert.notEqual(storedHash, 'example-password');
  const [salt, derivedKey] = storedHash.split(':');
  const expected = Buffer.from(derivedKey, 'hex');
  const actual = await scrypt('example-password', salt, expected.length);
  assert.equal(crypto.timingSafeEqual(expected, actual), true);
});

test('new replacement student accounts enforce minimum password length', async () => {
  await withServer({ pool: { query: async () => { throw new Error('must not query'); } } }, async baseUrl => {
    const response = await fetch(`${baseUrl}/api/students`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': 'test-api-key' },
      body: JSON.stringify({ student_id: 'TEST-1', full_name: 'Test Student', password: 'short' })
    });
    assert.equal(response.status, 400);
  });
});

test('student login accepts the existing Student Records salt:hash format', async () => {
  const salt = 'a'.repeat(32);
  const passwordHash = `${salt}:${(await scrypt('existing-password', salt, 64)).toString('hex')}`;
  const pool = {
    query: async () => ({ rows: [{ student_id: 'TEST-1', password_hash: passwordHash }] })
  };
  await withServer({ pool }, async baseUrl => {
    const response = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': 'test-api-key' },
      body: JSON.stringify({ student_id: 'TEST-1', password: 'existing-password' })
    });
    const data = await response.json();
    assert.equal(response.status, 200);
    assert.equal(data.student_id, 'TEST-1');
    assert.equal(typeof data.token, 'string');
  });
});

test('replacement schema is initialized using only the supplied Student Records pool', async () => {
  const statements = [];
  await initializeStudentRecordsDatabase({ query: async statement => statements.push(statement) });

  assert.equal(statements.length, 4);
  assert.match(statements[0], /CREATE TABLE IF NOT EXISTS students/);
  assert.match(statements[1], /CREATE TABLE IF NOT EXISTS grades/);
  assert.match(statements[3], /CREATE TABLE IF NOT EXISTS employees/);
  assert.ok(statements.every(statement => !statement.includes('main_students')));
});

test("grade transfer replaces a student's grades in one transaction", async () => {
  const statements = [];
  const client = {
    async query(statement, values) {
      statements.push({ statement, values });
      if (statement.startsWith('SELECT student_id')) return { rows: [{ student_id: 'TEST-1' }] };
      return { rows: [], rowCount: 1 };
    },
    release() {}
  };
  const pool = { connect: async () => client };
  await withServer({ pool }, async baseUrl => {
    const response = await fetch(`${baseUrl}/api/students/TEST-1/grades`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'x-api-key': 'test-api-key' },
      body: JSON.stringify([{ subject_code: 'IT101', subject_name: 'Systems', grade: 95 }])
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, student_id: 'TEST-1', imported: 1 });
  });
  assert.equal(statements[0].statement, 'BEGIN');
  assert.match(statements[1].statement, /FOR UPDATE/);
  assert.match(statements[2].statement, /DELETE FROM grades/);
  assert.match(statements[3].statement, /INSERT INTO grades/);
  assert.equal(statements.at(-1).statement, 'COMMIT');
});

test('grade transfer rolls back when the student does not exist', async () => {
  const statements = [];
  const client = {
    async query(statement) {
      statements.push(statement);
      if (statement.startsWith('SELECT student_id')) return { rows: [] };
      return { rows: [] };
    },
    release() {}
  };
  await withServer({ pool: { connect: async () => client } }, async baseUrl => {
    const response = await fetch(`${baseUrl}/api/students/MISSING/grades`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'x-api-key': 'test-api-key' },
      body: JSON.stringify([])
    });
    assert.equal(response.status, 404);
  });
  assert.equal(statements.at(-1), 'ROLLBACK');
  assert.equal(statements.some(statement => statement.startsWith('DELETE FROM grades')), false);
});