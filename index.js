const express = require('express');
const cors = require('cors');
const db = require('./db');

const app = express();

app.use(cors());
app.use(express.json());

// Инициализация БД: создаём таблицы, если их ещё нет
async function initDb() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS products (
      id SERIAL PRIMARY KEY,
      code VARCHAR(50) NOT NULL,
      name VARCHAR(255) NOT NULL,
      type VARCHAR(20) NOT NULL, -- Assembly / Part / Standard
      mass_kg NUMERIC(10,3),
      length_mm NUMERIC(10,1),
      width_mm NUMERIC(10,1),
      height_mm NUMERIC(10,1)
    );
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS bom_items (
      id SERIAL PRIMARY KEY,
      parent_product_id INT NOT NULL REFERENCES products(id),
      child_product_id INT NOT NULL REFERENCES products(id),
      quantity NUMERIC(10,3) NOT NULL
    );
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS cart_items (
      id SERIAL PRIMARY KEY,
      product_id INT NOT NULL REFERENCES products(id),
      quantity NUMERIC(10,3) NOT NULL
    );
  `);

  console.log('DB schema initialized');
}

// простой тестовый маршрут
app.get('/', (req, res) => {
  res.send('API is running');
});

// список изделий (пока просто всё из products)
app.get('/api/products/root', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT p.*
      FROM products p
      ORDER BY p.id
    `);
    res.json(result.rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal error' });
  }
});

// корзина
app.get('/api/cart', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT c.id, c.quantity,
             p.id as product_id, p.code, p.name
      FROM cart_items c
      JOIN products p ON p.id = c.product_id
      ORDER BY c.id;
    `);
    res.json(result.rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal error' });
  }
});

app.post('/api/cart', async (req, res) => {
  try {
    const { productId, quantity } = req.body;
    const result = await db.query(
      'INSERT INTO cart_items (product_id, quantity) VALUES ($1, $2) RETURNING *',
      [productId, quantity || 1]
    );
    res.status(201).json(result.rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal error' });
  }
});

app.delete('/api/cart/:id', async (req, res) => {
  try {
    const id = req.params.id;
    await db.query('DELETE FROM cart_items WHERE id = $1', [id]);
    res.status(204).end();
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal error' });
  }
});

const PORT = process.env.PORT || 3000;

initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Server started on port ${PORT}`);
    });
  })
  .catch(err => {
    console.error('Failed to init DB', err);
    process.exit(1);
  });
