require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');

const app = express();
app.use(express.json());

// Връзка с базата данни в Supabase
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// API 1: Приемане на сканиране от биометрия, карти или чипове
app.post('/api/hardware/scan', async (req, res) => {
  const { token, device_name, action_code, raw_data } = req.body;

  try {
    // Намиране на работника по RFID карта или биометричен ID
    const workerCheck = await pool.query(
      'SELECT id FROM workers WHERE card_token = \$1 OR biometric_id = \$1',
      [token]
    );

    if (workerCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Работниците не са намерени' });
    }
    const workerId = workerCheck.rows[0].id;

    // Намиране на типа действие
    const actionCheck = await pool.query(
      'SELECT id FROM activity_types WHERE code = \$1',
      [action_code]
    );
    if (actionCheck.rows.length === 0) {
      return res.status(400).json({ error: 'Невалиден код на действие' });
    }
    const actionTypeId = actionCheck.rows[0].id;

    // Запис в лога
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

// API 2: Изчисляване на заплати за период
app.post('/api/payroll/calculate', async (req, res) => {
  const { start_date, end_date } = req.body;

  try {
    // Вземане на всички активни работници
    const workers = await pool.query('SELECT id, hourly_rate FROM workers WHERE is_active = true');
    
    for (let worker of workers.rows) {
      // Извличане на всички логове за работника за периода, подредени по време
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

      // Изчисляване на чистите работни часове (Вход - Изход - Почивки)
      logs.rows.forEach(log => {
        if (log.code === 'clock_in') lastClockIn = new Date(log.timestamp);
        if (log.code === 'break_start') lastBreakStart = new Date(log.timestamp);
        if (log.code === 'break_end' && lastBreakStart) {
          if (lastClockIn) totalWorkMs -= (new Date(log.timestamp) - lastBreakStart); // Вадим почивката
        }
        if (log.code === 'clock_out' && lastClockIn) {
          totalWorkMs += (new Date(log.timestamp) - lastClockIn);
          lastClockIn = null; // Нулираме след изход
        }
      });

      const totalHours = totalWorkMs / (1000 * 60 * 60);
      const finalAmount = totalHours * worker.hourly_rate;

      // Запис в таблицата за плащания
      if (totalHours > 0) {
        await pool.query(
          `INSERT INTO payroll_payouts (worker_id, period_start, period_end, total_hours_worked, calculated_amount)
           VALUES ($1, $2, $3, $4, $5)`,
          [worker.id, start_date, end_date, totalHours.toFixed(2), finalAmount.toFixed(2)]
        );
      }
    }

    res.status(200).json({ success: true, message: 'Заплатите са пресметнати успешно' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Сървърът работи на порт ${PORT}`));
