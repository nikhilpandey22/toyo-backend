const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Ye function DB connect hote hi chalega
async function initDB() {
  try {
    await pool.query('SELECT NOW()'); // Force connection
    console.log('PostgreSQL tables ready ✅'); // Yaha print hoga
    
    await pool.query(`
      CREATE TABLE IF NOT EXISTS temperatures (
        id SERIAL PRIMARY KEY,
        temp_value FLOAT,
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('Tables created successfully');
  } catch (err) {
    console.error('DB Connection Error:', err.message);
    console.log('Mode: SIMULATION'); // Error me hi SIMULATION dikhega
  }
}

initDB();

module.exports = pool;