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
// Смени за графика. Ключът е това, което се показва в клетката. Променяй свободно.
const PRESETS = {
  'Д': { t: '08–16', h: 8 },
  'В': { t: '16–24', h: 8 },
  'Н': { t: '00–08', h: 8 },
  'Ц': { t: '08–20', h: 12 }
};

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Ако хостингът на базата ползва самоподписан сертификат, сложи DB_SSL_INSECURE=1
  ssl: process.env.DB_SSL_INSECURE === '1' ? { rejectUnauthorized: false } : true
});

// ---------- Помощни ----------
const fail = (res, err) => { console.error(err); res.status(500).json({ error: 'Грешка в сървъра' }); };
const bad = (res, msg) => res.status(400).json({ error: msg });
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
const clean = v => (v == null || String(v).trim() === '') ? null : String(v).trim();
const r2 = n => Math.round(n * 100) / 100;
const dayOf = d => new Date(d).toLocaleDateString('sv-SE', { timeZone: TZ }); // YYYY-MM-DD
const safeEq = (a, b) => {
  const A = Buffer.from(String(a)), B = Buffer.from(String(b));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
};

// ---------- API за терминали (ключ на устройството) ----------
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

// ---------- Всичко отдолу е с парола (HTTP Basic, потребителското име се игнорира) ----------
app.use((req, res, next) => {
  const pass = process.env.ADMIN_PASSWORD;
  const b = Buffer.from((req.headers.authorization || '').replace(/^Basic /, ''), 'base64').toString();
  const given = b.slice(b.indexOf(':') + 1);
  if (pass && safeEq(given, pass)) return next();
  res.set('WWW-Authenticate', 'Basic realm="Persona"').status(401).send('Нужна е парола');
});
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Служители ----------
app.get('/api/workers', async (req, res) => {
  try {
    const r = await pool.query('SELECT id, name, monthly_salary, card_token, biometric_id FROM workers WHERE is_active ORDER BY name');
    res.json(r.rows);
  } catch (e) { fail(res, e); }
});

app.post('/api/workers', async (req, res) => {
  const { name, monthly_salary, card_token, biometric_id } = req.body || {};
  if (!clean(name)) return bad(res, 'Липсва име');
  try {
    const r = await pool.query(
      'INSERT INTO workers (name, monthly_salary, card_token, biometric_id, is_active) VALUES ($1,$2,$3,$4,true) RETURNING id',
      [clean(name), Number(monthly_salary) || 0, clean(card_token), clean(biometric_id)]
    );
    res.json({ success: true, id: r.rows[0].id });
  } catch (e) { fail(res, e); }
});

app.put('/api/workers/:id', async (req, res) => {
  const { name, monthly_salary, card_token, biometric_id } = req.body || {};
  if (!clean(name)) return bad(res, 'Липсва име');
  try {
    await pool.query(
      'UPDATE workers SET name=$1, monthly_salary=$2, card_token=$3, biometric_id=$4 WHERE id=$5',
      [clean(name), Number(monthly_salary) || 0, clean(card_token), clean(biometric_id), req.params.id]
    );
    res.json({ success: true });
  } catch (e) { fail(res, e); }
});

app.delete('/api/workers/:id', async (req, res) => { // скрива, не трие историята
  try { await pool.query('UPDATE workers SET is_active=false WHERE id=$1', [req.params.id]); res.json({ success: true }); }
  catch (e) { fail(res, e); }
});

// ---------- График ----------
app.get('/api/shifts', async (req, res) => {
  const { from, to } = req.query;
  if (!isDate(from) || !isDate(to)) return bad(res, 'Невалидни дати');
  try {
    const r = await pool.query('SELECT worker_id, day::text AS day, label, hours FROM shifts WHERE day BETWEEN $1 AND $2', [from, to]);
    res.json({ presets: PRESETS, rows: r.rows });
  } catch (e) { fail(res, e); }
});

app.put('/api/shifts', async (req, res) => {
  const { worker_id, day, label } = req.body || {};
  if (!worker_id || !isDate(day)) return bad(res, 'Невалидни данни');
  try {
    if (!label) {
      await pool.query('DELETE FROM shifts WHERE worker_id=$1 AND day=$2', [worker_id, day]);
    } else {
      if (!PRESETS[label]) return bad(res, 'Непозната смяна');
      await pool.query(
        `INSERT INTO shifts (worker_id, day, label, hours) VALUES ($1,$2,$3,$4)
         ON CONFLICT (worker_id, day) DO UPDATE SET label=EXCLUDED.label, hours=EXCLUDED.hours`,
        [worker_id, day, label, PRESETS[label].h]
      );
    }
    res.json({ success: true });
  } catch (e) { fail(res, e); }
});

app.post('/api/shifts/copy-week', async (req, res) => {
  const { from_monday, to_monday } = req.body || {};
  if (!isDate(from_monday) || !isDate(to_monday)) return bad(res, 'Невалидни дати');
  try {
    await pool.query(
      `INSERT INTO shifts (worker_id, day, label, hours)
       SELECT worker_id, day + ($2::date - $1::date), label, hours
       FROM shifts WHERE day BETWEEN $1::date AND $1::date + 6
       ON CONFLICT (worker_id, day) DO UPDATE SET label=EXCLUDED.label, hours=EXCLUDED.hours`,
      [from_monday, to_monday]
    );
    res.json({ success: true });
  } catch (e) { fail(res, e); }
});

// ---------- Заплати: аванс и заплата по дни ----------
// Часовете се броят по дни (ден на започване на работата). Аванс = часове от start_date до advance_until.
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
    const workers = (await client.query('SELECT id, name, monthly_salary FROM workers WHERE is_active ORDER BY name')).rows;
    const byWorker = {}; // id -> [{day, h}]

    if (useSchedule) {
      const r = await client.query('SELECT worker_id, day::text AS day, hours FROM shifts WHERE day BETWEEN $1 AND $2', [start_date, end_date]);
      r.rows.forEach(x => (byWorker[x.worker_id] ||= []).push({ day: x.day, h: Number(x.hours) }));
    } else {
      const r = await client.query(
        `SELECT hl.worker_id, hl.timestamp, at.code
         FROM hardware_logs hl JOIN activity_types at ON hl.activity_type_id = at.id
         WHERE hl.timestamp >= $1::date - 1 AND hl.timestamp < $2::date + 2
         ORDER BY hl.worker_id, hl.timestamp`, [start_date, end_date]);
      const grouped = {};
      r.rows.forEach(x => (grouped[x.worker_id] ||= []).push(x));
      for (const id in grouped) byWorker[id] = workedSegments(grouped[id]);
    }

    const rows = [];
    await client.query('BEGIN');
    for (const w of workers) {
      let total = 0, adv = 0;
      for (const s of byWorker[w.id] || []) {
        if (s.day < start_date || s.day > end_date) continue;
        total += s.h;
        if (s.day <= advance_until) adv += s.h;
      }
      const rate = Number(w.monthly_salary) / MONTH_HOURS;
      const amount = r2(total * rate), advance = r2(adv * rate), salary = r2(amount - advance);
      rows.push({ worker_id: w.id, name: w.name, hours: r2(total), advance_hours: r2(adv), amount, advance, salary });
      await client.query('DELETE FROM payroll_payouts WHERE worker_id=$1 AND period_start=$2 AND period_end=$3', [w.id, start_date, end_date]);
      if (total > 0) {
        await client.query(
          `INSERT INTO payroll_payouts (worker_id, period_start, period_end, total_hours_worked, calculated_amount, advance_until, advance_amount, salary_amount)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [w.id, start_date, end_date, r2(total), amount, advance_until, advance, salary]
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
