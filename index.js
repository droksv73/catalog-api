// index.js  — основной сервер API для Render

const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

// ---------------------- Базовая настройка ----------------------

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());

// Подключение к БД
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL
    ? { rejectUnauthorized: false }
    : false,
});

// Небольшой helper, чтобы не падать с некрасивыми 500 без логов
function sendError(res, message, err, status = 500) {
  console.error(message, err);
  res.status(status).json({ error: message });
}

// Простейший health-check
app.get('/health', (req, res) => {
  res.json({ ok: true });
});

// ---------------------- Авторизация админа ----------------------

const ADMIN_USER = process.env.ADMIN_USER;
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';

// POST /api/admin/login  { email, password }
app.post('/api/admin/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'E-mail и пароль обязательны' });
    }

    if (email !== ADMIN_USER) {
      return res.status(401).json({ error: 'Неверный логин или пароль' });
    }

    const ok = await bcrypt.compare(password, ADMIN_PASSWORD_HASH);
    if (!ok) {
      return res.status(401).json({ error: 'Неверный логин или пароль' });
    }

    const token = jwt.sign({ role: 'admin' }, JWT_SECRET, {
      expiresIn: '8h',
    });

    res.json({ token });
  } catch (err) {
    sendError(res, 'Ошибка авторизации администратора', err);
  }
});

// GET /api/admin/verify  (Authorization: Bearer <token>)
app.get('/api/admin/verify', (req, res) => {
  try {
    const auth = req.headers.authorization || '';
    const [, token] = auth.split(' ');

    if (!token) {
      return res.status(401).json({ error: 'Токен не найден' });
    }

    jwt.verify(token, JWT_SECRET);
    res.json({ ok: true });
  } catch (err) {
    return res.status(401).json({ error: 'Невалидный токен' });
  }
});

// middleware для защищённых маршрутов
function requireAdmin(req, res, next) {
  try {
    const auth = req.headers.authorization || '';
    const [, token] = auth.split(' ');

    if (!token) {
      return res.status(401).json({ error: 'Токен не найден' });
    }

    jwt.verify(token, JWT_SECRET);
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Невалидный токен' });
  }
}

// ---------------------- Маршруты изделий ----------------------

// GET /api/products/root  — список всех изделий (корень дерева)
app.get('/api/products/root', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, code, name, type, mass_kg, length_mm, width_mm, height_mm
       FROM products
       ORDER BY id`
    );
    res.json(result.rows);
  } catch (err) {
    sendError(res, 'Не удалось загрузить корневые изделия', err);
  }
});

// GET /api/products/:id  — карточка изделия
app.get('/api/products/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ error: 'Некорректный ID' });
    }

    const result = await pool.query(
      `SELECT id, code, name, type, mass_kg, length_mm, width_mm, height_mm
       FROM products
       WHERE id = $1`,
      [id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Изделие не найдено' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    sendError(res, 'Ошибка загрузки карточки изделия', err);
  }
});

// GET /api/products/:id/children  — состав сборки
app.get('/api/products/:id/children', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ error: 'Некорректный ID сборки' });
    }

    const result = await pool.query(
      `SELECT
          bi.id            AS bom_item_id,
          bi.quantity      AS quantity,
          p.id             AS product_id,
          p.code,
          p.name,
          p.type,
          p.mass_kg,
          p.length_mm,
          p.width_mm,
          p.height_mm
       FROM bom_items bi
       JOIN products p ON p.id = bi.product_id
       WHERE bi.assembly_id = $1
       ORDER BY bi.id`,
      [id]
    );

    res.json(result.rows);
  } catch (err) {
    sendError(res, 'Ошибка загрузки состава сборки', err);
  }
});

// POST /api/products  — создать новое изделие (только админ)
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

    const result = await pool.query(
      `INSERT INTO products
         (code, name, type, mass_kg, length_mm, width_mm, height_mm)
       VALUES
         ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, code, name, type, mass_kg, length_mm, width_mm, height_mm`,
      [code, name, type, mass_kg, length_mm, width_mm, height_mm]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    sendError(res, 'Ошибка создания изделия', err);
  }
});

// PUT /api/products/:id  — обновить изделие (только админ)
app.put('/api/products/:id', requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ error: 'Некорректный ID' });
    }

    const {
      code,
      name,
      type,
      mass_kg,
      length_mm,
      width_mm,
      height_mm,
    } = req.body;

    const result = await pool.query(
      `UPDATE products
         SET code = $1,
             name = $2,
             type = $3,
             mass_kg = $4,
             length_mm = $5,
             width_mm = $6,
             height_mm = $7
       WHERE id = $8
       RETURNING id, code, name, type, mass_kg, length_mm, width_mm, height_mm`,
      [code, name, type, mass_kg, length_mm, width_mm, height_mm, id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Изделие не найдено' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    sendError(res, 'Ошибка обновления изделия', err);
  }
});

// DELETE /api/products/:id — удалить изделие (только админ)
// Перед удалением чистим ссылки из bom_items и cart_items, чтобы не было 500 по внешнему ключу
app.delete('/api/products/:id', requireAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      client.release();
      return res.status(400).json({ error: 'Некорректный ID' });
    }

    await client.query('BEGIN');

    // удаляем из состава всех сборок
    await client.query(
      'DELETE FROM bom_items WHERE assembly_id = $1 OR product_id = $1',
      [id]
    );

    // удаляем из корзины
    await client.query('DELETE FROM cart_items WHERE product_id = $1', [id]);

    // само изделие
    const result = await client.query(
      'DELETE FROM products WHERE id = $1 RETURNING id',
      [id]
    );

    await client.query('COMMIT');

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Изделие не найдено' });
    }

    res.json({ ok: true });
  } catch (err) {
    await pool.query('ROLLBACK').catch(() => {});
    sendError(res, 'Ошибка удаления изделия', err);
  } finally {
    client.release();
  }
});

// ---------------------- Корзина ----------------------

// GET /api/cart
app.get('/api/cart', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT
          c.id,
          c.product_id,
          c.quantity,
          p.code,
          p.name
       FROM cart_items c
       JOIN products p ON p.id = c.product_id
       ORDER BY c.id`
    );
    res.json(result.rows);
  } catch (err) {
    sendError(res, 'Ошибка загрузки корзины', err);
  }
});

// POST /api/cart  { product_id, quantity }
app.post('/api/cart', async (req, res) => {
  try {
    const { product_id, quantity } = req.body;

    const result = await pool.query(
      `INSERT INTO cart_items (product_id, quantity)
       VALUES ($1, $2)
       RETURNING id, product_id, quantity`,
      [product_id, quantity]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    sendError(res, 'Ошибка добавления в корзину', err);
  }
});

// DELETE /api/cart/:id
app.delete('/api/cart/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ error: 'Некорректный ID позиции корзины' });
    }

    const result = await pool.query(
      'DELETE FROM cart_items WHERE id = $1 RETURNING id',
      [id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Позиция корзины не найдена' });
    }

    res.json({ ok: true });
  } catch (err) {
    sendError(res, 'Ошибка удаления из корзины', err);
  }
});

// ---------------------- Запуск ----------------------

app.listen(PORT, () => {
  console.log(`API server is running on port ${PORT}`);
});
