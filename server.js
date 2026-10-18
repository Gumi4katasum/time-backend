require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');

const app = express();
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// API 1: Приемане на сканиране
app.post('/api/hardware/scan', async (req, res) => {
  const { token, device_name, action_code, raw_data } = req.body;
  try {
    const workerCheck = await pool.query('SELECT id FROM workers WHERE card_token = $1 OR biometric_id = $1', [token]);
    if (workerCheck.rows.length === 0) return res.status(404).json({ error: 'Работниците не са намерени' });
    
    const workerId = workerCheck.rows[0].id;
    const actionCheck = await pool.query('SELECT id FROM activity_types WHERE code = $1', [action_code]);
    if (actionCheck.rows.length === 0) return res.status(400).json({ error: 'Невалиден код на действие' });
    
    const actionTypeId = actionCheck.rows[0].id;
    await pool.query(
      `INSERT INTO hardware_logs (worker_id, activity_type_id, device_source, raw_hardware_data) VALUES ($1, $2, $3, $4)`,
      [workerId, actionTypeId, device_name, raw_data || '']
    );
    res.status(200).json({ success: true, message: 'Успешно маркиране' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API 2: Изчисляване на заплати (МЕСЕЧНА СТАВКА)
app.post('/api/payroll/calculate', async (req, res) => {
  const { start_date, end_date } = req.body;
  try {
    // Вземаме месечната заплата (monthly_salary)
    const workers = await pool.query('SELECT id, monthly_salary FROM workers WHERE is_active = true');
    
    for (let worker of workers.rows) {
      const logs = await pool.query(
        `SELECT hl.timestamp, at.code FROM hardware_logs hl
         JOIN activity_types at ON hl.activity_type_id = at.id
         WHERE hl.worker_id = $1 AND hl.timestamp::date BETWEEN $2 AND $3 ORDER BY hl.timestamp ASC`,
        [worker.id, start_date, end_date]
      );

      let totalWorkMs = 0;
      let lastClockIn = null;

      logs.rows.forEach(log => {
        if (log.code === 'clock_in') lastClockIn = new Date(log.timestamp);
        if (log.code === 'break_start' && lastClockIn) {
          totalWorkMs += (new Date(log.timestamp) - lastClockIn);
          lastClockIn = null; 
        }
        if (log.code === 'break_end') lastClockIn = new Date(log.timestamp);
        if (log.code === 'clock_out' && lastClockIn) {
          totalWorkMs += (new Date(log.timestamp) - lastClockIn);
          lastClockIn = null;
        }
      });

      const totalHours = totalWorkMs / (1000 * 60 * 60);
      
      // Изчисляваме пропорционално спрямо 168 часа (стандартен месец)
      const hourlyRate = worker.monthly_salary / 168; 
      const finalAmount = totalHours * hourlyRate;
      
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
    res.status(200).json({ success: true, message: 'Заплатите са пресметнати успешно' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API 3: Моментно състояние
app.get('/api/status/live', async (req, res) => {
  try {
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

// УЕБ ТАБЛО (НОВИЯТ КРАСИВ ИНТЕРФЕЙС)
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <title>Управление на персонала</title>
      <style>
        body { font-family: 'Segoe UI', Arial; background: #eef2f5; margin: 0; padding: 20px; }
        .container { max-width: 900px; margin: auto; background: white; border-radius: 8px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); overflow: hidden; }
        .header { background: #2c3e50; color: white; padding: 20px; text-align: center; }
        .tabs { display: flex; background: #ecf0f1; }
        .tab { flex: 1; padding: 15px; text-align: center; cursor: pointer; font-weight: bold; color: #7f8c8d; }
        .tab.active { background: white; color: #2c3e50; border-bottom: 3px solid #3498db; }
        .content { padding: 20px; }
        table { width: 100%; border-collapse: collapse; margin-top: 10px; }
        th, td { padding: 12px; border-bottom: 1px solid #ddd; text-align: left; }
        th { background: #f8f9fa; color: #2c3e50; }
        .badge { padding: 4px 8px; border-radius: 4px; color: white; font-size: 12px; font-weight: bold; }
        .in { background: #27ae60; }
        .out { background: #c0392b; }
        .break { background: #f39c12; }
        .payroll-form { background: #f8f9fa; padding: 20px; border-radius: 8px; margin-top: 20px; }
        input[type="date"] { padding: 8px; border: 1px solid #ccc; border-radius: 4px; margin-right: 10px; }
        button { background: #3498db; color: white; border: none; padding: 10px 20px; border-radius: 4px; cursor: pointer; font-weight: bold; }
        button:hover { background: #2980b9; }
        #result { margin-top: 15px; font-weight: bold; color: #27ae60; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>Система за управление на персонала</h1>
        </div>
        <div class="tabs">
          <div class="tab active" onclick="showTab('live')">На живо (Статус)</div>
          <div class="tab" onclick="showTab('payroll')">Финанси (Заплати)</div>
        </div>

        <div id="tab-live" class="content">
          <h2>Кой е на работа в момента?</h2>
          <table id="live-table">
            <thead>
              <tr><th>Служител</th><th>Статус</th><th>От колко време?</th></tr>
            </thead>
            <tbody id="live-body">
              <tr><td colspan="3">Зареждане...</td></tr>
            </tbody>
          </table>
        </div>

        <div id="tab-payroll" class="content" style="display:none;">
          <h2>Изчисляване на възнаграждения</h2>
          <div class="payroll-form">
            <label>От дата:</label> <input type="date" id="start_date">
            <label>До дата:</label> <input type="date" id="end_date">
            <button onclick="calculatePayroll()">Изчисли</button>
            <div id="result"></div>
          </div>
        </div>
      </div>

      <script>
        function showTab(tabName) {
          document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
          document.querySelectorAll('.content').forEach(c => c.style.display = 'none');
          
          if (tabName === 'live') {
            document.querySelectorAll('.tab')[0].classList.add('active');
            document.getElementById('tab-live').style.display = 'block';
            loadLiveStatus();
          } else {
            document.querySelectorAll('.tab')[1].classList.add('active');
            document.getElementById('tab-payroll').style.display = 'block';
          }
        }

        async function loadLiveStatus() {
          try {
            const res = await fetch('/api/status/live');
            const data = await res.json();
            const tbody = document.getElementById('live-body');
            tbody.innerHTML = '';

            if (data.length === 0) {
              tbody.innerHTML = '<tr><td colspan="3">Няма сканирания днес.</td></tr>';
              return;
            }

            data.forEach(emp => {
              let statusText = '';
              let badgeClass = '';
              if (emp.code === 'clock_in' || emp.code === 'break_end') {
                statusText = 'На работа'; badgeClass = 'in';
              } else if (emp.code === 'clock_out') {
                statusText = 'Излязъл'; badgeClass = 'out';
              } else if (emp.code === 'break_start') {
                statusText = 'В почивка'; badgeClass = 'break';
              }

              const timeStr = new Date(emp.timestamp).toLocaleTimeString('bg-BG', {hour: '2-digit', minute:'2-digit'});
              
              tbody.innerHTML += \`
                <tr>
                  <td><strong>\${emp.name}</strong></td>
                  <td><span class="badge \${badgeClass}">\${statusText}</span></td>
                  <td>От \${timeStr} ч.</td>
                </tr>
              \`;
            });
          } catch (e) {
            console.error("Грешка при зареждане:", e);
          }
        }

        async function calculatePayroll() {
          const start = document.getElementById('start_date').value;
          const end = document.getElementById('end_date').value;
          const resultDiv = document.getElementById('result');

          if (!start || !end) {
            resultDiv.style.color = 'red';
            resultDiv.innerText = 'Моля, изберете дати!';
            return;
          }

          resultDiv.style.color = 'black';
          resultDiv.innerText = 'Изчисляване...';

          try {
            const res = await fetch('/api/payroll/calculate', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ start_date: start, end_date: end })
            });
            const data = await res.json();
            
            if (data.success) {
              resultDiv.style.color = 'green';
              resultDiv.innerText = '✅ ' + data.message;
            } else {
              resultDiv.style.color = 'red';
              resultDiv.innerText = 'Грешка: ' + data.error;
            }
          } catch (e) {
            resultDiv.style.color = 'red';
            resultDiv.innerText = 'Грешка при връзката.';
          }
        }

        loadLiveStatus();
        setInterval(loadLiveStatus, 30000); 
      </script>
    </body>
    </html>
  `);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Сървърът работи на порт ${PORT}`));
