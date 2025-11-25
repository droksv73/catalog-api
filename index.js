// index.js – основной сервер каталога для интернета

const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();

// ---------- конфигурация PG ----------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL
    ? { rejectUnauthorized: false } // для Render
    : false,
});

// ---------- базовые настройки ----------
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;

// маленький хелпер для запросов к БД
async function dbQuery(text, params) {
  const client = await pool.connect();
  try {
    const res = await client.query(text, params);
    return res;
  } finally {
    client.release();
  }
}

// ---------- авторизация администратора ----------

const ADMIN_USER = process.env.ADMIN_USER;
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';

// POST /api/admin/login  {email, password}
app.post('/api/admin/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Нужно указать email и пароль' });
    }

    if (email !== ADMIN_USER) {
      return res.status(401).json({ error: 'Неверный логин или пароль' });
    }

    const ok = await bcrypt.compare(password, ADMIN_PASSWORD_HASH);
    if (!ok) {
      return res.status(401).json({ error: 'Неверный логин или пароль' });
    }

    const token = jwt.sign({ role: 'admin', email }, JWT_SECRET, {
      expiresIn: '8h',
    });

    res.json({ token });
  } catch (err) {
    console.error('Ошибка /api/admin/login', err);
    res.status(500).json({ error: 'Ошибка авторизации администратора' });
  }
});

// middleware для проверки JWT администратора
function requireAdmin(req, res, next) {
  const auth = req.headers.authorization || '';
  const [, token] = auth.split(' ');

  if (!token) {
    return res.status(401).json({ error: 'Требуется авторизация администратора' });
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.role !== 'admin') {
      return res.status(403).json({ error: 'Недостаточно прав' });
    }
    req.admin = payload;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Неверный или истёкший токен' });
  }
}

// ---------- служебный маршрут ----------
app.get('/api/health', async (req, res) => {
  try {
    await dbQuery('SELECT 1');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---------- каталожные маршруты (чтение, публичные) ----------

// GET /api/products/root – корень дерева (изделия без родителей в BOM)
app.get('/api/products/root', async (req, res) => {
  try {
    const result = await dbQuery(
      `
      SELECT p.id, p.code, p.name, p.type,
             p.mass_kg, p.length_mm, p.width_mm, p.height_mm
      FROM products p
      LEFT JOIN bom_items b ON p.id = b.child_id
      WHERE b.child_id IS NULL
      ORDER BY p.code;
      `
    );

    res.json(result.rows);
  } catch (err) {
    console.error('Ошибка /api/products/root', err);
    res.status(500).json({ error: 'Ошибка загрузки корня дерева' });
  }
});

// GET /api/products/:id – карточка изделия
app.get('/api/products/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await dbQuery(
      `
      SELECT id, code, name, type,
             mass_kg, length_mm, width_mm, height_mm
      FROM products
      WHERE id = $1;
      `,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Изделие не найдено' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Ошибка /api/products/:id', err);
    res.status(500).json({ error: 'Ошибка загрузки карточки изделия' });
  }
});

// GET /api/products/:id/children – состав (узлы/детали) сборки
app.get('/api/products/:id/children', async (req, res) => {
  const { id } = req.params;

  try {
    const result = await dbQuery(
      `
      SELECT
        b.id        AS bom_item_id,
        b.quantity  AS quantity,
        p.id        AS product_id,
        p.code,
        p.name,
        p.type,
        p.mass_kg,
        p.length_mm,
        p.width_mm,
        p.height_mm
      FROM bom_items b
      JOIN products p ON p.id = b.child_id
      WHERE b.parent_id = $1
      ORDER BY b.id;
      `,
      [id]
    );

    res.json(result.rows);
  } catch (err) {
    console.error('Ошибка /api/products/:id/children', err);
    res.status(500).json({ error: 'Ошибка загрузки состава сборки' });
  }
});

// ---------- корзина (публичные маршруты) ----------

// GET /api/cart – текущая корзина
app.get('/api/cart', async (req, res) => {
  try {
    const result = await dbQuery(
      `
      SELECT
        c.id,
        c.quantity,
        p.id   AS product_id,
        p.code,
        p.name,
        p.type,
        p.mass_kg,
        p.length_mm,
        p.width_mm,
        p.height_mm
      FROM cart_items c
      JOIN products p ON p.id = c.product_id
      ORDER BY c.id;
      `
    );

    res.json(result.rows);
  } catch (err) {
    console.error('Ошибка /api/cart', err);
    res.status(500).json({ error: 'Ошибка загрузки корзины' });
  }
});

// POST /api/cart/add  {productId, quantity}
app.post('/api/cart/add', async (req, res) => {
  try {
    const { productId, quantity } = req.body;
    const q = Number(quantity) || 1;

    if (!productId) {
      return res.status(400).json({ error: 'Не указан productId' });
    }

    // если позиция уже есть – увеличиваем количество
    await dbQuery(
      `
      INSERT INTO cart_items (product_id, quantity)
      VALUES ($1, $2)
      ON CONFLICT (product_id)
      DO UPDATE SET quantity = cart_items.quantity + EXCLUDED.quantity;
      `,
      [productId, q]
    );

    res.json({ ok: true });
  } catch (err) {
    console.error('Ошибка /api/cart/add', err);
    res.status(500).json({ error: 'Ошибка добавления в корзину' });
  }
});

// POST /api/cart/clear – очистить корзину
app.post('/api/cart/clear', async (req, res) => {
  try {
    await dbQuery('DELETE FROM cart_items');
    res.json({ ok: true });
  } catch (err) {
    console.error('Ошибка /api/cart/clear', err);
    res.status(500).json({ error: 'Ошибка очистки корзины' });
  }
});

// ---------- админ-маршруты для изделий ----------

// Создать новое изделие
app.post('/api/products', requireAdmin, async (req, res) => {
  try {
    const {
      code,
      name,
      type,
      mass_kg,
      length_mm,
      width_mm,
      height_mm,
    } = req.body;

    const result = await dbQuery(
      `
      INSERT INTO products
        (code, name, type, mass_kg, length_mm, width_mm, height_mm)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *;
      `,
      [code, name, type, mass_kg, length_mm, width_mm, height_mm]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Ошибка POST /api/products', err);
    res.status(500).json({ error: 'Ошибка создания изделия' });
  }
});

// Обновить изделие
app.put('/api/products/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    const {
      code,
      name,
      type,
      mass_kg,
      length_mm,
      width_mm,
      height_mm,
    } = req.body;

    const result = await dbQuery(
      `
      UPDATE products
      SET code = $1,
          name = $2,
          type = $3,
          mass_kg = $4,
          length_mm = $5,
          width_mm = $6,
          height_mm = $7
      WHERE id = $8
      RETURNING *;
      `,
      [code, name, type, mass_kg, length_mm, width_mm, height_mm, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Изделие не найдено' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Ошибка PUT /api/products/:id', err);
    res.status(500).json({ error: 'Ошибка обновления изделия' });
  }
});

// Удалить изделие
app.delete('/api/products/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;

  try {
    // сначала удаляем связи в BOM и в корзине
    await dbQuery('DELETE FROM bom_items WHERE parent_id = $1 OR child_id = $1', [id]);
    await dbQuery('DELETE FROM cart_items WHERE product_id = $1', [id]);

    const result = await dbQuery('DELETE FROM products WHERE id = $1 RETURNING id;', [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Изделие не найдено' });
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('Ошибка DELETE /api/products/:id', err);
    res.status(500).json({ error: 'Ошибка удаления изделия' });
  }
});

// ---------- запуск ----------
app.listen(PORT, () => {
  console.log(`API server listening on port ${PORT}`);
});
