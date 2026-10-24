require('dotenv').config();

const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { Pool } = require('pg');

const app = express();
app.use(express.json());

// ---------- Настройки ----------
const TZ = process.env.TZ_NAME || 'Europe/Sofia';
const MONTH_HOURS = 168; // стандартен месец за часова ставка
const toMin = t => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
const hoursBetween = (a, b) => { let d = toMin(b) - toMin(a); if (d <= 0) d += 1440; return Math.round(d / 6) / 10; };
const isTime = s => /^([01]\d|2[0-3]):[0-5]\d$/.test(s || '');
const isColor = s => /^#[0-9a-fA-F]{6}$/.test(s || '');
async function loadTypes(db = pool) {
  const r = await db.query('SELECT code, start_time, end_time, hours, color, department FROM shift_types ORDER BY created_at, code');
  const o = {};
  r.rows.forEach(x => o[x.code] = { t: `${x.start_time}–${x.end_time}`, start_time: x.start_time, end_time: x.end_time, h: Number(x.hours), color: x.color, department: x.department });
  return o;
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DB_SSL_INSECURE === '1' ? { rejectUnauthorized: false } : true
});

// ---------- Помощни ----------
const fail = (res, err) => { console.error(err); res.status(500).json({ error: 'Грешка в сървъра' }); };
const bad = (res, msg) => res.status(400).json({ error: msg });
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
const clean = v => (v == null || String(v).trim() === '') ? null : String(v).trim();
const r2 = n => Math.round(n * 100) / 100;
const dayOf = d => new Date(d).toLocaleDateString('sv-SE', { timeZone: TZ });
const safeEq = (a, b) => {
  const A = Buffer.from(String(a)), B = Buffer.from(String(b));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
};

// ---------- API за терминали ----------
app.post('/api/hardware/scan', async (req, res) => {
  const key = process.env.DEVICE_KEY;
  if (!key || !safeEq(req.get('x-device-key') || '', key)) return res.status(401).json({ error: 'Невалиден ключ' });
  const { token, device_name, action_code, raw_data } = req.body || {};
  if (!token || !action_code) return bad(res, 'Липсват данни');
  try {
    const w = await pool.query('SELECT id FROM workers WHERE is_active AND (card_token = $1 OR biometric_id = $1)', [String(token)]);
    if (!w.rows.length) return res.status(404).json({ error: 'Работникът не е намерен' });
    const a = await pool.query('SELECT id FROM activity_types WHERE code = $1', [action_code]);
    if (!a.rows.length) return bad(res, 'Невалиден код на действие');
    await pool.query(
      'INSERT INTO hardware_logs (worker_id, activity_type_id, device_source, raw_hardware_data) VALUES ($1, $2, $3, $4)',
      [w.rows[0].id, a.rows[0].id, device_name || '', raw_data || '']
    );
    res.json({ success: true, message: 'Успешно маркиране' });
  } catch (e) { fail(res, e); }
});

// ---------- Публична страница ----------
app.get('/schedule', (req, res) => res.sendFile(path.join(__dirname, 'schedule.html')));
app.get('/api/public/workers', async (req, res) => {
  try { res.json((await pool.query('SELECT id, name FROM workers WHERE is_active ORDER BY name')).rows); }
  catch (e) { fail(res, e); }
});
app.get('/api/public/schedule', async (req, res) => {
  const { worker_id, from, to } = req.query;
  if (!worker_id || !isDate(from) || !isDate(to)) return bad(res, 'Невалидни данни');
  try {
    const r = await pool.query('SELECT day::text AS day, label, hours FROM shifts WHERE worker_id=$1 AND day BETWEEN $2 AND $3', [worker_id, from, to]);
    res.json({ types: await loadTypes(), rows: r.rows });
  } catch (e) { fail(res, e); }
});

// ---------- Админ защита ----------
app.use((req, res, next) => {
  const pass = process.env.ADMIN_PASSWORD;
  const b = Buffer.from((req.headers.authorization || '').replace(/^Basic /, ''), 'base64').toString();
  const given = b.slice(b.indexOf(':') + 1);
  if (pass && safeEq(given, pass)) return next();
  res.set('WWW-Authenticate', 'Basic realm="Persona"').status(401).send('Нужна е парола');
});
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// ---------- Служители ----------
async function saveRates(db, workerId, rates, deptText) {
  const allowed = new Set(String(deptText || '').split(',').map(x => x.trim()).filter(Boolean));
  await db.query('DELETE FROM worker_rates WHERE worker_id=$1', [workerId]);
  for (const [d, val] of Object.entries(rates || {})) {
    const n = Number(val);
    if (allowed.has(d) && n > 0) await db.query('INSERT INTO worker_rates (worker_id, department, hourly_rate) VALUES ($1,$2,$3)', [workerId, d, n]);
  }
}
const newToken = () => crypto.randomBytes(24).toString('hex');
const WCOLS = 'id, name, department, monthly_salary, card_token, biometric_id, view_token';

app.get('/api/workers', async (req, res) => {
  try {
    const [r, rr] = await Promise.all([
      pool.query(`SELECT ${WCOLS} FROM workers WHERE is_active ORDER BY name`),
      pool.query('SELECT worker_id, department, hourly_rate FROM worker_rates')
    ]);
    const rates = {};
    rr.rows.forEach(x => (rates[x.worker_id] ||= {})[x.department] = Number(x.hourly_rate));
    res.json(r.rows.map(w => ({ ...w, rates: rates[w.id] || {} })));
  } catch (e) { fail(res, e); }
});

app.post('/api/workers', async (req, res) => {
  const { name, department, monthly_salary, card_token, biometric_id, rates } = req.body || {};
  if (!clean(name)) return bad(res, 'Липсва име');
  try {
    const r = await pool.query(
      'INSERT INTO workers (name, department, monthly_salary, card_token, biometric_id, view_token, is_active) VALUES ($1,$2,$3,$4,$5,$6,true) RETURNING id',
      [clean(name), clean(department), Number(monthly_salary) || 0, clean(card_token), clean(biometric_id), newToken()]
    );
    await saveRates(pool, r.rows[0].id, rates, department);
    res.json({ success: true, id: r.rows[0].id });
  } catch (e) { fail(res, e); }
});

app.put('/api/workers/:id', async (req, res) => {
  const { name, department, monthly_salary, card_token, biometric_id, rates } = req.body || {};
  if (!clean(name)) return bad(res, 'Липсва име');
  try {
    await pool.query(
      'UPDATE workers SET name=$1, department=$2, monthly_salary=$3, card_token=$4, biometric_id=$5 WHERE id=$6',
      [clean(name), clean(department), Number(monthly_salary) || 0, clean(card_token), clean(biometric_id), req.params.id]
    );
    await saveRates(pool, req.params.id, rates, department);
    res.json({ success: true });
  } catch (e) { fail(res, e); }
});

app.post('/api/workers/:id/new-link', async (req, res) => {
  try {
    const r = await pool.query('UPDATE workers SET view_token=$1 WHERE id=$2 RETURNING view_token', [newToken(), req.params.id]);
    res.json({ success: true, view_token: r.rows[0]?.view_token });
  } catch (e) { fail(res, e); }
});

app.delete('/api/workers/:id', async (req, res) => {
  try { await pool.query('UPDATE workers SET is_active=false WHERE id=$1', [req.params.id]); res.json({ success: true }); }
  catch (e) { fail(res, e); }
});

// ---------- Аванси ----------
app.get('/api/advances', async (req, res) => {
  const { from, to } = req.query;
  if (!isDate(from) || !isDate(to)) return bad(res, 'Невалидни дати');
  try {
    const r = await pool.query(
      `SELECT a.id, a.worker_id, a.day::text AS day, a.amount, a.note, w.name
       FROM advances a JOIN workers w ON w.id = a.worker_id
       WHERE a.day BETWEEN $1 AND $2
       ORDER BY a.day, w.name`, [from, to]);
    res.json(r.rows);
  } catch (e) { fail(res, e); }
});

app.post('/api/advances', async (req, res) => {
  const { worker_id, day, amount, note } = req.body || {};
  if (!worker_id || !isDate(day)) return bad(res, 'Невалидни данни');
  const n = Number(amount);
  if (!(n > 0)) return bad(res, 'Сумата трябва да е положителна');
  try {
    const r = await pool.query(
      'INSERT INTO advances (worker_id, day, amount, note) VALUES ($1,$2,$3,$4) RETURNING id',
      [worker_id, day, n, clean(note)]);
    res.json({ success: true, id: r.rows[0].id });
  } catch (e) { fail(res, e); }
});

app.delete('/api/advances/:id', async (req, res) => {
  try { await pool.query('DELETE FROM advances WHERE id=$1', [req.params.id]); res.json({ success: true }); }
  catch (e) { fail(res, e); }
});

app.get('/api/advances/summary', async (req, res) => {
  const { month, advance_until } = req.query;
  if (!/^\d{4}-\d{2}$/.test(month || '') || !isDate(advance_until)) return bad(res, 'Невалидни данни');
  const start = month + '-01';
  const end = month + '-31';
  try {
    const workers = (await pool.query('SELECT id, name, department FROM workers WHERE is_active ORDER BY name')).rows;
    const manual = (await pool.query(
      `SELECT worker_id, COALESCE(SUM(amount),0) AS s FROM advances
       WHERE day BETWEEN $1 AND $2 GROUP BY worker_id`, [start, end])).rows;
    const mMap = {}; manual.forEach(x => mMap[x.worker_id] = Number(x.s));
    res.json(workers.map(w => ({ ...w, manual_advance: mMap[w.id] || 0 })));
  } catch (e) { fail(res, e); }
});

// ---------- Видове смени ----------
const readType = b => {
  b = b || {};
  const code = clean(b.code);
  if (!code || code.length > 20 || !isTime(b.start_time) || !isTime(b.end_time) || !isColor(b.color)) return null;
  return { code, st: b.start_time, en: b.end_time, h: hoursBetween(b.start_time, b.end_time), color: b.color, dep: clean(b.department) };
};

app.get('/api/shift-types', async (req, res) => {
  try { res.json(await loadTypes()); } catch (e) { fail(res, e); }
});

app.post('/api/shift-types', async (req, res) => {
  const t = readType(req.body);
  if (!t) return bad(res, 'Попълни име на смяната (до 20 знака), начало, край и цвят');
  try {
    await pool.query('INSERT INTO shift_types (code, start_time, end_time, hours, color, department) VALUES ($1,$2,$3,$4,$5,$6)', [t.code, t.st, t.en, t.h, t.color, t.dep]);
    res.json({ success: true });
  } catch (e) { if (e.code === '23505') return bad(res, 'Вече има смяна с това кратко име'); fail(res, e); }
});

app.put('/api/shift-types/:code', async (req, res) => {
  const t = readType({ ...req.body, code: req.params.code });
  if (!t) return bad(res, 'Невалидни данни');
  try {
    await pool.query('UPDATE shift_types SET start_time=$2, end_time=$3, hours=$4, color=$5, department=$6 WHERE code=$1', [t.code, t.st, t.en, t.h, t.color, t.dep]);
    res.json({ success: true });
  } catch (e) { fail(res, e); }
});

app.delete('/api/shift-types/:code', async (req, res) => {
  try {
    const u = await pool.query('SELECT 1 FROM shifts WHERE label=$1 LIMIT 1', [req.params.code]);
    if (u.rows.length) return res.status(409).json({ error: 'Смяната е използвана в графика. Първо я изтрий оттам.' });
    await pool.query('DELETE FROM shift_types WHERE code=$1', [req.params.code]);
    res.json({ success: true });
  } catch (e) { fail(res, e); }
});

// ---------- График ----------
app.get('/api/shifts', async (req, res) => {
  const { from, to } = req.query;
  if (!isDate(from) || !isDate(to)) return bad(res, 'Невалидни дати');
  try {
    const r = await pool.query('SELECT worker_id, day::text AS day, label, hours, department FROM shifts WHERE day BETWEEN $1 AND $2', [from, to]);
    res.json({ presets: await loadTypes(), rows: r.rows });
  } catch (e) { fail(res, e); }
});

const UPSERT = `INSERT INTO shifts (worker_id, day, label, hours, department) VALUES ($1,$2,$3,$4,$5)
  ON CONFLICT (worker_id, day) DO UPDATE SET label=EXCLUDED.label, hours=EXCLUDED.hours, department=EXCLUDED.department`;
const depClean = d => { d = clean(d); return d ? d.slice(0, 40) : null; };

app.put('/api/shifts', async (req, res) => {
  const { worker_id, day, label, department } = req.body || {};
  if (!worker_id || !isDate(day)) return bad(res, 'Невалидни данни');
  try {
    if (!label) {
      await pool.query('DELETE FROM shifts WHERE worker_id=$1 AND day=$2', [worker_id, day]);
    } else {
      const T = await loadTypes();
      if (!T[label]) return bad(res, 'Непозната смяна');
      await pool.query(UPSERT, [worker_id, day, label, T[label].h, depClean(department)]);
    }
    res.json({ success: true });
  } catch (e) { fail(res, e); }
});

app.put('/api/shifts/bulk', async (req, res) => {
  const items = (req.body || {}).items;
  if (!Array.isArray(items) || !items.length || items.length > 400) return bad(res, 'Невалидни данни');
  const client = await pool.connect();
  try {
    const T = await loadTypes(client);
    for (const it of items) {
      if (!it.worker_id || !isDate(it.day) || (it.label && !T[it.label])) return bad(res, 'Невалидни данни');
    }
    await client.query('BEGIN');
    for (const it of items) {
      if (!it.label) await client.query('DELETE FROM shifts WHERE worker_id=$1 AND day=$2', [it.worker_id, it.day]);
      else await client.query(UPSERT, [it.worker_id, it.day, it.label, T[it.label].h, depClean(it.department)]);
    }
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    fail(res, e);
  } finally { client.release(); }
});

// НОВА заявка за копиране на произволен брой дни
app.post('/api/shifts/copy-range', async (req, res) => {
  const { from_start, from_end, to_start } = req.body || {};
  if (!isDate(from_start) || !isDate(from_end) || !isDate(to_start)) return bad(res, 'Невалидни дати');
  try {
    await pool.query(
      `INSERT INTO shifts (worker_id, day, label, hours, department)
       SELECT worker_id, day + ($3::date - $1::date), label, hours, department
       FROM shifts WHERE day BETWEEN $1::date AND $2::date
       ON CONFLICT (worker_id, day) DO UPDATE SET label=EXCLUDED.label, hours=EXCLUDED.hours, department=EXCLUDED.department`,
      [from_start, from_end, to_start]
    );
    res.json({ success: true });
  } catch (e) { fail(res, e); }
});

// ---------- Заплати ----------
function workedSegments(logs) {
  const out = [];
  let start = null;
  for (const l of logs) {
    const t = new Date(l.timestamp);
    if (l.code === 'clock_in' || l.code === 'break_end') start = t;
    else if ((l.code === 'break_start' || l.code === 'clock_out') && start) {
      out.push({ day: dayOf(start), h: (t - start) / 3600000 });
      start = null;
    }
  }
  return out;
}

app.post('/api/payroll/calculate', async (req, res) => {
  const { start_date, end_date, advance_until, source } = req.body || {};
  if (![start_date, end_date, advance_until].every(isDate)) return bad(res, 'Невалидни дати');
  const useSchedule = source === 'schedule';
  const client = await pool.connect();
  try {
    const workers = (await client.query('SELECT id, name, department, monthly_salary FROM workers WHERE is_active ORDER BY name')).rows;
    const rates = {};
    (await client.query('SELECT worker_id, department, hourly_rate FROM worker_rates')).rows.forEach(x => rates[x.worker_id + '|' + x.department] = Number(x.hourly_rate));
    
    const advMap = {};
    (await client.query(
      `SELECT worker_id, COALESCE(SUM(amount),0) AS s FROM advances
       WHERE day BETWEEN $1 AND $2 GROUP BY worker_id`, [start_date, advance_until]
    )).rows.forEach(x => advMap[x.worker_id] = Number(x.s));

    const sched = (await client.query('SELECT worker_id, day::text AS day, hours, department FROM shifts WHERE day BETWEEN $1 AND $2', [start_date, end_date])).rows;
    const depOfDay = {};
    sched.forEach(x => depOfDay[x.worker_id + '|' + x.day] = x.department);
    const byWorker = {}; 

    if (useSchedule) {
      sched.forEach(x => (byWorker[x.worker_id] ||= []).push({ day: x.day, h: Number(x.hours), dept: x.department }));
    } else { 
      const r = await client.query(
        `SELECT hl.worker_id, hl.timestamp, at.code
         FROM hardware_logs hl JOIN activity_types at ON hl.activity_type_id = at.id
         WHERE hl.timestamp >= $1::date - 1 AND hl.timestamp < $2::date + 2
         ORDER BY hl.worker_id, hl.timestamp`, [start_date, end_date]);
      const grouped = {};
      r.rows.forEach(x => (grouped[x.worker_id] ||= []).push(x));
      for (const id in grouped) byWorker[id] = workedSegments(grouped[id]).map(s => ({ ...s, dept: depOfDay[id + '|' + s.day] || null }));
    }

    const rows = [];
    await client.query('BEGIN');
    for (const w of workers) {
      const wd = String(w.department || '').split(',').map(x => x.trim()).filter(Boolean);
      const groups = {}; 
      for (const s of byWorker[w.id] || []) {
        if (s.day < start_date || s.day > end_date) continue;
        const d = s.dept || (wd.length === 1 ? wd[0] : '');
        const g = (groups[d] ||= { h: 0, adv: 0 });
        g.h += s.h;
        if (s.day <= advance_until) g.adv += s.h;
      }
      
      const parts = Object.entries(groups).map(([d, g]) => {
        const rate = rates[w.id + '|' + d] ?? Number(w.monthly_salary) / MONTH_HOURS;
        const amount = r2(g.h * rate), advanceCalc = r2(g.adv * rate);
        return { department: d, hours: r2(g.h), advance_hours: r2(g.adv), rate: r2(rate), amount, advance: advanceCalc, salary: r2(amount - advanceCalc) };
      });
      
      const sum = k => r2(parts.reduce((a, p) => a + p[k], 0));
      const hours = sum('hours'), amount = sum('amount');
      const manualAdvance = r2(advMap[w.id] || 0);
      const advance = r2(sum('advance') + manualAdvance);
      const salary = r2(amount - advance);

      rows.push({ 
        worker_id: w.id, 
        name: w.name, 
        department: w.department, 
        parts, 
        hours, 
        advance_hours: sum('advance_hours'), 
        amount, 
        manual_advance: manualAdvance,
        advance, 
        salary 
      });
      
      await client.query('DELETE FROM payroll_payouts WHERE worker_id=$1 AND period_start=$2 AND period_end=$3', [w.id, start_date, end_date]);
      if (hours > 0) {
        await client.query(
          `INSERT INTO payroll_payouts (worker_id, period_start, period_end, total_hours_worked, calculated_amount, advance_until, advance_amount, salary_amount)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [w.id, start_date, end_date, hours, amount, advance_until, advance, salary]
        );
      }
    }
    await client.query('COMMIT');
    res.json({ success: true, rows });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    fail(res, e);
  } finally { client.release(); }
});

// ---------- На живо ----------
app.get('/api/status/live', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT DISTINCT ON (w.id) w.name, a.code, hl.timestamp
       FROM workers w
       JOIN hardware_logs hl ON w.id = hl.worker_id
       JOIN activity_types a ON hl.activity_type_id = a.id
       WHERE w.is_active AND (hl.timestamp AT TIME ZONE $1)::date = (now() AT TIME ZONE $1)::date
       ORDER BY w.id, hl.timestamp DESC`, [TZ]);
    res.json(r.rows);
  } catch (e) { fail(res, e); }
});

if (!process.env.ADMIN_PASSWORD) console.warn('ВНИМАНИЕ: няма ADMIN_PASSWORD – таблото е заключено за всички.');
if (!process.env.DEVICE_KEY) console.warn('ВНИМАНИЕ: няма DEVICE_KEY – терминалите не могат да сканират.');

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Сървърът работи на порт ${PORT}`));
