// index.js
// Простой API для каталога изделий + корзина на Node + Postgres (Render)

const express = require('express');
const cors = require('cors');
const db = require('./db');

const app = express();

app.use(cors());
app.use(express.json());

/**
 * Инициализация БД:
 *  - создаём таблицы, если их нет
 *  - один раз заполняем демо-данными
 */
async function initDb() {
  // Таблица изделий
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

  // Таблица структуры изделия (сборка → деталь/подсборка/стандарт)
  await db.query(`
    CREATE TABLE IF NOT EXISTS bom_items (
      id SERIAL PRIMARY KEY,
      parent_product_id INT NOT NULL REFERENCES products(id),
      child_product_id INT NOT NULL REFERENCES products(id),
      quantity NUMERIC(10,3) NOT NULL
    );
  `);

  // Таблица корзины
  await db.query(`
    CREATE TABLE IF NOT EXISTS cart_items (
      id SERIAL PRIMARY KEY,
      product_id INT NOT NULL REFERENCES products(id),
      quantity NUMERIC(10,3) NOT NULL
    );
  `);

  // Проверяем, есть ли хоть одно изделие
  const countRes = await db.query('SELECT COUNT(*) FROM products');
  const count = Number(countRes.rows[0].count || 0);

  // Если пусто — заполняем демо-набором
  if (count === 0) {
    // Изделия
    await db.query(`
      INSERT INTO products (code, name, type, mass_kg, length_mm, width_mm, height_mm)
      VALUES
        ('ASM-001', 'Сборка демонстрационная', 'Assembly', 50.0, 1000, 500, 400), -- id = 1
        ('PRT-001', 'Деталь корпус',          'Part',     10.0, 500,  300, 200), -- id = 2
        ('PRT-002', 'Деталь вал',             'Part',      5.0, 400,   80,  80), -- id = 3
        ('STD-001', 'Подшипник 6205',         'Standard',  0.5,  25,   25,  15); -- id = 4
    `);

    // Структура изделия:
    // ASM-001 состоит из PRT-001 и PRT-002, а PRT-002 содержит 2 подшипника STD-001
    await db.query(`
      INSERT INTO bom_items (parent_product_id, child_product_id, quantity)
      VALUES
        (1, 2, 1),  -- ASM-001 → PRT-001
        (1, 3, 1),  -- ASM-001 → PRT-002
        (3, 4, 2);  -- PRT-002 → STD-001 (2 шт.)
    `);

    console.log('Demo data inserted');
  }

  console.log('DB schema initialized');
}

/**
 * CRUD-маршруты
 */

// Тестовый корень
app.get('/', (req, res) => {
  res.send('API is running');
});

// Список "корневых" изделий.
// В простом варианте возьмём все сборки (type = 'Assembly').
app.get('/api/products/root', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT *
       FROM products
       WHERE type = 'Assembly'
       ORDER BY id;`
    );
    res.json(result.rows);
  } catch (e) {
    console.error('GET /api/products/root error:', e);
    res.status(500).json({ error: 'Internal error' });
  }
});

// Карточка изделия по id
app.get('/api/products/:id', async (req, res) => {
  const id = Number(req.params.id);

  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'Invalid id' });
  }

  try {
    const result = await db.query(
      'SELECT * FROM products WHERE id = $1',
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }

    res.json(result.rows[0]);
  } catch (e) {
    console.error('GET /api/products/:id error:', e);
    res.status(500).json({ error: 'Internal error' });
  }
});

// Дети (состав) изделия по id сборки
app.get('/api/products/:id/children', async (req, res) => {
  const id = Number(req.params.id);

  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'Invalid id' });
  }

  try {
    const result = await db.query(
      `
      SELECT
        b.id              AS bom_item_id,
        b.quantity        AS quantity,
        c.id              AS product_id,
        c.code,
        c.name,
        c.type,
        c.mass_kg,
        c.length_mm,
        c.width_mm,
        c.height_mm
      FROM bom_items b
      JOIN products c ON c.id = b.child_product_id
      WHERE b.parent_product_id = $1
      ORDER BY b.id;
      `,
      [id]
    );

    res.json(result.rows);
  } catch (e) {
    console.error('GET /api/products/:id/children error:', e);
    res.status(500).json({ error: 'Internal error' });
  }
});

// Корзина: получить все позиции
app.get('/api/cart', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT
        c.id,
        c.quantity,
        p.id   AS product_id,
        p.code,
        p.name
      FROM cart_items c
      JOIN products p ON p.id = c.product_id
      ORDER BY c.id;
    `);

    res.json(result.rows);
  } catch (e) {
    console.error('GET /api/cart error:', e);
    res.status(500).json({ error: 'Internal error' });
  }
});

// Корзина: добавить позицию
app.post('/api/cart', async (req, res) => {
  try {
    const { productId, quantity } = req.body;

    const prodId = Number(productId);
    const qty = quantity ? Number(quantity) : 1;

    if (!Number.isInteger(prodId) || !(qty > 0)) {
      return res.status(400).json({ error: 'Invalid productId or quantity' });
    }

    // на всякий случай проверим, что товар существует
    const prodRes = await db.query(
      'SELECT id FROM products WHERE id = $1',
      [prodId]
    );
    if (prodRes.rows.length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }

    const result = await db.query(
      'INSERT INTO cart_items (product_id, quantity) VALUES ($1, $2) RETURNING *',
      [prodId, qty]
    );

    res.status(201).json(result.rows[0]);
  } catch (e) {
    console.error('POST /api/cart error:', e);
    res.status(500).json({ error: 'Internal error' });
  }
});

// Корзина: удалить позицию
app.delete('/api/cart/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'Invalid id' });
  }

  try {
    await db.query('DELETE FROM cart_items WHERE id = $1', [id]);
    res.status(204).end();
  } catch (e) {
    console.error('DELETE /api/cart/:id error:', e);
    res.status(500).json({ error: 'Internal error' });
  }
});

// Запуск сервера после инициализации БД
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
