// index.js — сервер для каталога (онлайн + админ)

const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('./db'); // db.js с Pool из pg

const app = express();

// ----- базовая настройка -----

app.use(cors());
app.use(express.json());

// удобный лог ошибок
function logError(context, err) {
  console.error(`--- [ERROR] ${context} ---`);
  console.error(err);
  console.error('------------------------------');
}

// ----- вспомогательные функции -----

// JWT для админа
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';

// проверка админ-токена
function requireAdmin(req, res, next) {
  try {
    const auth = req.headers['authorization'] || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    if (!token) {
      return res
        .status(401)
        .json({ error: 'Требуется авторизация администратора' });
    }

    const payload = jwt.verify(token, JWT_SECRET);
    if (!payload || payload.role !== 'admin') {
      return res
        .status(403)
        .json({ error: 'Недостаточно прав (нужен администратор)' });
    }

    req.admin = payload;
    next();
  } catch (err) {
    logError('requireAdmin', err);
    return res
      .status(401)
      .json({ error: 'Неверный или просроченный токен администратора' });
  }
}

// нормализация числовых полей из тела запроса
function normalizeNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const num = Number(value);
  return Number.isNaN(num) ? null : num;
}

// ----- ПУБЛИЧНЫЕ ЭНДПОИНТЫ (чтение) -----

// Корневые изделия (не входят как дочерние ни в одну сборку)
app.get('/api/products/root', async (req, res) => {
  try {
    const sql = `
      SELECT p.*
      FROM products p
      WHERE NOT EXISTS (
        SELECT 1 FROM bom_items b
        WHERE b.child_product_id = p.id
      )
      ORDER BY p.code;
    `;
    const result = await pool.query(sql);
    res.json(result.rows);
  } catch (err) {
    logError('GET /api/products/root', err);
    res.status(500).json({ error: 'Failed to load root products' });
  }
});

// Карточка изделия
app.get('/api/products/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'Некорректный id изделия' });
  }

  try {
    const result = await pool.query(
      'SELECT * FROM products WHERE id = $1',
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Изделие не найдено' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    logError('GET /api/products/:id', err);
    res.status(500).json({ error: 'Ошибка загрузки изделия' });
  }
});

// Состав сборки (дети)
app.get('/api/products/:id/children', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'Некорректный id изделия' });
  }

  try {
    const sql = `
      SELECT
        b.id            AS bom_item_id,
        b.quantity      AS quantity,
        p.id            AS product_id,
        p.code,
        p.name,
        p.type,
        p.mass_kg,
        p.length_mm,
        p.width_mm,
        p.height_mm
      FROM bom_items b
      JOIN products p ON p.id = b.child_product_id
      WHERE b.product_id = $1
      ORDER BY p.code;
    `;
    const result = await pool.query(sql, [id]);
    res.json(result.rows);
  } catch (err) {
    logError('GET /api/products/:id/children', err);
    res.status(500).json({ error: 'Ошибка загрузки состава' });
  }
});

// ----- КОРЗИНА (в память, как и было) -----

let cart = [];
let nextCartId = 1;

app.get('/api/cart', (req, res) => {
  res.json(cart);
});

// добавить позицию в корзину
app.post('/api/cart/add', async (req, res) => {
  try {
    const { product_id, quantity } = req.body;
    const pid = Number(product_id);
    const qty = normalizeNumber(quantity) || 1;

    if (!Number.isInteger(pid)) {
      return res.status(400).json({ error: 'Некорректный id изделия' });
    }

    // найдём изделие для отображения в корзине
    const productResult = await pool.query(
      'SELECT id, code, name FROM products WHERE id = $1',
      [pid]
    );
    if (productResult.rows.length === 0) {
      return res.status(404).json({ error: 'Изделие не найдено' });
    }

    const item = {
      id: nextCartId++,
      product_id: pid,
      quantity: qty,
      code: productResult.rows[0].code,
      name: productResult.rows[0].name
    };

    cart.push(item);
    res.status(201).json(item);
  } catch (err) {
    logError('POST /api/cart/add', err);
    res.status(500).json({ error: 'Ошибка добавления в корзину' });
  }
});

// удалить одну позицию из корзины
app.delete('/api/cart/:id', (req, res) => {
  const id = Number(req.params.id);
  cart = cart.filter((item) => item.id !== id);
  res.json({ success: true });
});

// очистить корзину
app.delete('/api/cart', (req, res) => {
  cart = [];
  res.json({ success: true });
});

// ----- АДМИН-АВТОРИЗАЦИЯ -----

app.post('/api/admin/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};

    const adminUser = process.env.ADMIN_USER;
    const adminHash = process.env.ADMIN_PASSWORD_HASH;

    if (!adminUser || !adminHash) {
      return res
        .status(500)
        .json({ error: 'Админ-учётка не настроена на сервере' });
    }

    if (email !== adminUser) {
      return res.status(401).json({ error: 'Неверный логин или пароль' });
    }

    const ok = await bcrypt.compare(password || '', adminHash);
    if (!ok) {
      return res.status(401).json({ error: 'Неверный логин или пароль' });
    }

    const token = jwt.sign(
      { role: 'admin', email: adminUser },
      JWT_SECRET,
      { expiresIn: '8h' }
    );

    res.json({ token });
  } catch (err) {
    logError('POST /api/admin/login', err);
    res.status(500).json({ error: 'Ошибка авторизации администратора' });
  }
});

// ----- АДМИН: CRUD по изделиям -----

// создать изделие
app.post('/api/admin/products', requireAdmin, async (req, res) => {
  try {
    const {
      code,
      name,
      type,
      mass_kg,
      length_mm,
      width_mm,
      height_mm
    } = req.body || {};

    const result = await pool.query(
      `
      INSERT INTO products
        (code, name, type, mass_kg, length_mm, width_mm, height_mm)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *;
      `,
      [
        code,
        name,
        type,
        normalizeNumber(mass_kg),
        normalizeNumber(length_mm),
        normalizeNumber(width_mm),
        normalizeNumber(height_mm)
      ]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    logError('POST /api/admin/products', err);
    res.status(500).json({ error: 'Ошибка создания изделия' });
  }
});

// обновить изделие
app.put('/api/admin/products/:id', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'Некорректный id изделия' });
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
    } = req.body || {};

    const result = await pool.query(
      `
      UPDATE products
      SET
        code = $1,
        name = $2,
        type = $3,
        mass_kg = $4,
        length_mm = $5,
        width_mm = $6,
        height_mm = $7
      WHERE id = $8
      RETURNING *;
      `,
      [
        code,
        name,
        type,
        normalizeNumber(mass_kg),
        normalizeNumber(length_mm),
        normalizeNumber(width_mm),
        normalizeNumber(height_mm),
        id
      ]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Изделие не найдено' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    logError('PUT /api/admin/products/:id', err);
    res.status(500).json({ error: 'Ошибка обновления изделия' });
  }
});

// удалить изделие
app.delete('/api/admin/products/:id', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'Некорректный id изделия' });
  }

  try {
    // 1) удалить все связи в bom_items
    await pool.query(
      `
      DELETE FROM bom_items
      WHERE product_id = $1 OR child_product_id = $1;
      `,
      [id]
    );

    // 2) удалить само изделие
    const result = await pool.query(
      'DELETE FROM products WHERE id = $1 RETURNING *;',
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Изделие не найдено' });
    }

    res.json({ success: true });
  } catch (err) {
    logError('DELETE /api/admin/products/:id', err);
    res.status(500).json({ error: 'Ошибка удаления изделия' });
  }
});

// ----- запуск -----

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`API server listening on port ${PORT}`);
});
