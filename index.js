// index.js
// API для каталога изделий + структура + корзина
// Node + Express + Postgres (Render)

const express = require('express');
const cors = require('cors');
const db = require('./db');

const app = express();

app.use(cors());
app.use(express.json());

// ---------------- ИНИЦИАЛИЗАЦИЯ БД ----------------

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

  const countRes = await db.query('SELECT COUNT(*) FROM products');
  const count = Number(countRes.rows[0].count || 0);

  if (count === 0) {
    await db.query(`
      INSERT INTO products (code, name, type, mass_kg, length_mm, width_mm, height_mm)
      VALUES
        ('ASM-001', 'Сборка демонстрационная', 'Assembly', 50.0, 1000, 500, 400), -- id = 1
        ('PRT-001', 'Деталь корпус',          'Part',     10.0, 500,  300, 200), -- id = 2
        ('PRT-002', 'Деталь вал',             'Part',      5.0, 400,   80,  80), -- id = 3
        ('STD-001', 'Подшипник 6205',         'Standard',  0.5,  25,   25,  15); -- id = 4
    `);

    await db.query(`
      INSERT INTO bom_items (parent_product_id, child_product_id, quantity)
      VALUES
        (1, 2, 1),
        (1, 3, 1),
        (3, 4, 2);
    `);

    console.log('Demo data inserted');
  }

  console.log('DB schema initialized');
}

// ---------------- ОБЩЕЕ ----------------

app.get('/', (req, res) => {
  res.send('API is running');
});

// ---------------- КАТАЛОГ: ПРОДУКТЫ ----------------

// корневые (сборки)
app.get('/api/products/root', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT * FROM products
      WHERE type = 'Assembly'
      ORDER BY id
    `);
    res.json(result.rows);
  } catch (e) {
    console.error('GET /api/products/root error:', e);
    res.status(500).json({ error: 'Internal error' });
  }
});

// карточка по id
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

// ОБНОВЛЕНИЕ продукта (редактирование)
app.patch('/api/products/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'Invalid id' });
  }

  try {
    const {
      code,
      name,
      type,
      mass_kg,
      length_mm,
      width_mm,
      height_mm
    } = req.body;

    const fields = [];
    const values = [];
    let idx = 1;

    function addField(name, value) {
      fields.push(`${name} = $${idx}`);
      values.push(value);
      idx++;
    }

    if (code !== undefined) addField('code', String(code).trim());
    if (name !== undefined) addField('name', String(name).trim());
    if (type !== undefined) {
      const allowed = ['Assembly', 'Part', 'Standard'];
      if (!allowed.includes(type)) {
        return res.status(400).json({ error: 'Invalid type' });
      }
      addField('type', type);
    }

    function numOrNull(v) {
      if (v === undefined || v === null || v === '') return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    }

    if (mass_kg !== undefined) addField('mass_kg', numOrNull(mass_kg));
    if (length_mm !== undefined) addField('length_mm', numOrNull(length_mm));
    if (width_mm !== undefined) addField('width_mm', numOrNull(width_mm));
    if (height_mm !== undefined) addField('height_mm', numOrNull(height_mm));

    if (fields.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    values.push(id);

    const result = await db.query(
      `UPDATE products SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
      values
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }

    res.json(result.rows[0]);
  } catch (e) {
    console.error('PATCH /api/products/:id error:', e);
    res.status(500).json({ error: 'Internal error' });
  }
});

// УДАЛЕНИЕ продукта (полностью)
app.delete('/api/products/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'Invalid id' });
  }

  try {
    await db.query('BEGIN');
    await db.query('DELETE FROM cart_items WHERE product_id = $1', [id]);
    await db.query(
      'DELETE FROM bom_items WHERE parent_product_id = $1 OR child_product_id = $1',
      [id]
    );
    const result = await db.query('DELETE FROM products WHERE id = $1 RETURNING *', [id]);
    await db.query('COMMIT');

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }

    res.status(204).end();
  } catch (e) {
    await db.query('ROLLBACK');
    console.error('DELETE /api/products/:id error:', e);
    res.status(500).json({ error: 'Internal error' });
  }
});

// ---------------- КАТАЛОГ: СОСТАВ (BOM) ----------------

// дети изделия
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
      ORDER BY b.id
      `,
      [id]
    );
    res.json(result.rows);
  } catch (e) {
    console.error('GET /api/products/:id/children error:', e);
    res.status(500).json({ error: 'Internal error' });
  }
});

// обновление количества в BOM
app.patch('/api/bom-items/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'Invalid BOM item id' });
  }
  const { quantity } = req.body;
  const qty = Number(quantity);
  if (!(qty > 0)) {
    return res.status(400).json({ error: 'Invalid quantity' });
  }
  try {
    const result = await db.query(
      'UPDATE bom_items SET quantity = $1 WHERE id = $2 RETURNING *',
      [qty, id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'BOM item not found' });
    }
    res.json(result.rows[0]);
  } catch (e) {
    console.error('PATCH /api/bom-items/:id error:', e);
    res.status(500).json({ error: 'Internal error' });
  }
});

// удаление строки из BOM (убрать деталь из сборки)
app.delete('/api/bom-items/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'Invalid BOM item id' });
  }
  try {
    await db.query('DELETE FROM bom_items WHERE id = $1', [id]);
    res.status(204).end();
  } catch (e) {
    console.error('DELETE /api/bom-items/:id error:', e);
    res.status(500).json({ error: 'Internal error' });
  }
});

// ---------------- СОЗДАНИЕ НОВОГО УЗЛА ----------------

app.post('/api/nodes', async (req, res) => {
  try {
    let {
      parentId,
      code,
      name,
      type,
      mass_kg,
      length_mm,
      width_mm,
      height_mm,
      quantity
    } = req.body;

    if (!code || !name || !type) {
      return res.status(400).json({ error: 'code, name и type обязательны' });
    }

    const allowedTypes = ['Assembly', 'Part', 'Standard'];
    if (!allowedTypes.includes(type)) {
      return res.status(400).json({ error: 'type должен быть Assembly | Part | Standard' });
    }

    const parentIdNum = parentId ? Number(parentId) : null;

    function numOrNull(v) {
      if (v === undefined || v === null || v === '') return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    }

    const massNum = numOrNull(mass_kg);
    const lenNum  = numOrNull(length_mm);
    const widNum  = numOrNull(width_mm);
    const heiNum  = numOrNull(height_mm);
    const qtyNum  = quantity !== undefined && quantity !== null && quantity !== ''
      ? Number(quantity) : 1;

    const productRes = await db.query(
      `INSERT INTO products (code, name, type, mass_kg, length_mm, width_mm, height_mm)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        String(code).trim(),
        String(name).trim(),
        type,
        massNum,
        lenNum,
        widNum,
        heiNum
      ]
    );
    const product = productRes.rows[0];

    if (parentIdNum) {
      const q = qtyNum > 0 ? qtyNum : 1;
      await db.query(
        `INSERT INTO bom_items (parent_product_id, child_product_id, quantity)
         VALUES ($1, $2, $3)`,
        [parentIdNum, product.id, q]
      );
    }

    res.status(201).json({ product });
  } catch (e) {
    console.error('POST /api/nodes error:', e);
    res.status(500).json({ error: 'Internal error' });
  }
});

// ---------------- КОРЗИНА ----------------

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
      ORDER BY c.id
    `);
    res.json(result.rows);
  } catch (e) {
    console.error('GET /api/cart error:', e);
    res.status(500).json({ error: 'Internal error' });
  }
});

app.post('/api/cart', async (req, res) => {
  try {
    const { productId, quantity } = req.body;
    const prodId = Number(productId);
    const qty = quantity ? Number(quantity) : 1;

    if (!Number.isInteger(prodId) || !(qty > 0)) {
      return res.status(400).json({ error: 'Invalid productId or quantity' });
    }

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

// ---------------- ЗАПУСК ----------------

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
