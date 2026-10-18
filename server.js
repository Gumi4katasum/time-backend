require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');

const app = express();
app.use(express.json());

// Връзка с базата данни в Supabase
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});


// API 1: Приемане на сканиране
app.post('/api/hardware/scan', async (req, res) => {
  const { token, device_name, action_code, raw_data } = req.body;

  try {
    const workerCheck = await pool.query(
      'SELECT id FROM workers WHERE card_token = $1 OR biometric_id = $1',
      [token]
    );

    if (workerCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Работниците не са намерени' });
    }
    const workerId = workerCheck.rows[0].id;

    const actionCheck = await pool.query(
      'SELECT id FROM activity_types WHERE code = $1',
      [action_code]
    );
    if (actionCheck.rows.length === 0) {
      return res.status(400).json({ error: 'Невалиден код на действие' });
    }
    const actionTypeId = actionCheck.rows[0].id;

    await pool.query(
      `INSERT INTO hardware_logs (worker_id, activity_type_id, device_source, raw_hardware_data) 
       VALUES ($1, $2, $3, $4)`,
      [workerId, actionTypeId, device_name, raw_data || '']
    );

    res.status(200).json({ success: true, message: 'Успешно маркиране' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API 2: Изчисляване на заплати
app.post('/api/payroll/calculate', async (req, res) => {
  const { start_date, end_date } = req.body;

  try {
    const workers = await pool.query('SELECT id, hourly_rate FROM workers WHERE is_active = true');
    
    for (let worker of workers.rows) {
      const logs = await pool.query(
        `SELECT hl.timestamp, at.code 
         FROM hardware_logs hl
         JOIN activity_types at ON hl.activity_type_id = at.id
         WHERE hl.worker_id = $1 AND hl.timestamp::date BETWEEN $2 AND $3
         ORDER BY hl.timestamp ASC`,
        [worker.id, start_date, end_date]
      );

      let totalWorkMs = 0;
      let lastClockIn = null;
      let lastBreakStart = null;

      logs.rows.forEach(log => {
        if (log.code === 'clock_in') lastClockIn = new Date(log.timestamp);
        if (log.code === 'break_start') lastBreakStart = new Date(log.timestamp);
        if (log.code === 'break_end' && lastBreakStart) {
          if (lastClockIn) totalWorkMs -= (new Date(log.timestamp) - lastBreakStart);
        }
        if (log.code === 'clock_out' && lastClockIn) {
          totalWorkMs += (new Date(log.timestamp) - lastClockIn);
          lastClockIn = null;
        }
      });

      const totalHours = totalWorkMs / (1000 * 60 * 60);
      const finalAmount = totalHours * worker.hourly_rate;
      
      if (totalHours > 0) {
        await pool.query(
          `DELETE FROM payroll_payouts WHERE worker_id = $1 AND period_start = $2 AND period_end = $3`,
          [worker.id, start_date, end_date]
        );

        await pool.query(
          `INSERT INTO payroll_payouts (worker_id, period_start, period_end, total_hours_worked, calculated_amount)
           VALUES ($1, $2, $3, $4, $5)`,
          [worker.id, start_date, end_date, totalHours.toFixed(2), finalAmount.toFixed(2)]
        );
      }
    }
    
    // ТУК БЕШЕ ЛИПСВАЩАТА ЧАСТ
    res.status(200).json({ success: true, message: 'Заплатите са пресметнати успешно' });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// УЕБ ТАБЛО (DASHBOARD)
// API за моментно състояние (Кой е на работа в момента)
app.get('/api/status/live', async (req, res) => {
  try {
    // Вземаме последното действие на всеки служител днес
    const query = `
      SELECT DISTINCT ON (w.id) w.name, a.code, a.description, hl.timestamp
      FROM workers w
      JOIN hardware_logs hl ON w.id = hl.worker_id
      JOIN activity_types a ON hl.activity_type_id = a.id
      WHERE hl.timestamp::date = CURRENT_DATE
      ORDER BY w.id, hl.timestamp DESC
    `;
    const result = await pool.query(query);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.get('/', async (req, res) => {
  try {
    const logs = await pool.query(`
      SELECT w.name, a.code, hl.timestamp 
      FROM hardware_logs hl
      JOIN workers w ON hl.worker_id = w.id
      JOIN activity_types a ON hl.activity_type_id = a.id
      ORDER BY hl.timestamp DESC LIMIT 20
    `);

    let rows = '';
    logs.rows.forEach(log => {
      const color = log.code === 'clock_in' ? 'green' : (log.code === 'clock_out' ? 'red' : 'orange');
      const type = log.code === 'clock_in' ? 'ВХОД' : (log.code === 'clock_out' ? 'ИЗХОД' : 'ПОЧИВКА');
      rows += `<tr>
                 <td>${log.name}</td>
                 <td style="color:${color}; font-weight:bold;">${type}</td>
                 <td>${new Date(log.timestamp).toLocaleString('bg-BG')}</td>
               </tr>`;
    });

    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <title>Работно Време - Табло</title>
        <style>
          body { font-family: Arial; background: #f4f6f9; padding: 20px; }
          h1 { color: #333; }
          table { width: 100%; border-collapse: collapse; background: white; margin-top: 20px; }
          th, td { padding: 12px; border-bottom: 1px solid #ddd; text-align: left; }
          th { background: #34495e; color: white; }
        </style>
      </head>
      <body>
        <h1>Табло за Работно Време</h1>
        <h3>Последни 20 сканирания:</h3>
        <table>
          <tr><th>Служител</th><th>Действие</th><th>Дата и Час</th></tr>
          ${rows}
        </table>
      </body>
      </html>
    `);
  } catch (err) {
    res.status(500).send("Грешка при зареждане на данните: " + err.message);
  }
});

// СТАРТИРАНЕ НА СЪРВЪРА
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Сървърът работи на порт ${PORT}`));
