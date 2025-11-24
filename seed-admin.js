// seed-admin.js
require('dotenv').config(); // чтобы подтянуть DATABASE_URL из .env
const bcrypt = require('bcrypt');
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false }
});

async function main() {
  const email = 'dro.ksv73@gmail.com';
  const plainPassword = 'DD123123dd';

  // можно и не считать заново, но пусть будет
  const hash = await bcrypt.hash(plainPassword, 10);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS admins (
      id            serial PRIMARY KEY,
      email         text    NOT NULL UNIQUE,
      password_hash text    NOT NULL,
      is_admin      boolean NOT NULL DEFAULT true
    );
  `);

  await pool.query(
    `
    INSERT INTO admins (email, password_hash, is_admin)
    VALUES ($1, $2, true)
    ON CONFLICT (email) DO UPDATE
       SET password_hash = EXCLUDED.password_hash,
           is_admin      = EXCLUDED.is_admin;
  `,
    [email, hash]
  );

  console.log('Администратор обновлён/создан:', email);
  await pool.end();
}

main().catch(err => {
  console.error('Ошибка при создании админа:', err);
  process.exit(1);
});
