// index.js – API для каталога крана КС-8165 (интернет-версия)

import express from 'express';
import cors from 'cors';
import pkg from 'pg';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

const { Pool } = pkg;

const app = express();
const PORT = process.env.PORT || 10000;

// ---------- БАЗА ДАННЫХ ----------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL
    ? { rejectUnauthorized: false }
    : false
});

// ---------- МИДЛВАРЫ ----------
app.use(cors());
app.use(express.json());

// маленький хелпер для логов
function logError(place, err) {
  console.error(`[${place}]`, err.message, err.stack);
}

// ---------- АУТЕНТИФИКАЦИЯ АДМИНА ----------

const ADMIN_USER = process.env.ADMIN_USER || 'dro.ksv73@gmail.com';
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH || '';
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';

// POST /api/admin/login  { email, password }
app.post('/api/admin/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};

    if (!email || !password) {
      return res.status(400).json({ error: 'Не указан логин или пароль' });
    }

    if (email !== ADMIN_USER) {
      return res.status(401).json({ error: 'Неверный логин или пароль' });
    }

    const ok = await bcrypt.compare(password, ADMIN_PASSWORD_HASH);
    if (!ok) {
      return res.status(401).json({ error: 'Неверный логин или пароль' });
    }

    const token = jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: '8h' });
    res.json({ token });
  } catch (err) {
    logError('admin/login', err);
    res.status(500).json({ error: 'Ошибка авторизации администратора' });
  }
});

// мидлвар для эндпоинтов, где нужна админ-права
function requireAdmin(req, res, next) {
  const header = req.headers.authorization || '';
  const [, token] = header.split(' ');

  if (!token) {
    return res.status(401).json({ error: 'Требуется авторизация администратора' });
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.role !== 'admin') {
      throw new Error('wrong role');
    }
    req.admin = payload;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Неверный или просроченный токен администратора' });
  }
}

// ---------- ПРОДУКТЫ ----------

// GET /api/products/root – элементы верхнего уровня дерева
app.get('/api/products/root', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `
      SELECT p.id, p.code, p.name, p.type,
             p.mass_kg, p.length_mm, p.width_mm, p.height_mm
      FROM products p
      WHERE NOT EXISTS (
        SELECT 1
        FROM bom_items b
        WHERE b.child_product_id = p.id
      )
      ORDER BY p.id
      `
    );
    res.json(rows);
  } catch (err) {
    logError('products/root', err);
    res.status(500).json({ error: 'Ошибка загрузки корня дерева' });
  }
});

// GET /api/products/:id – карточка изделия
app.get('/api/products/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'Некорректный ID' });
  }

  try {
    const { rows } = await pool.query(
      `
      SELECT id, code, name, type,
             mass_kg, length_mm, width_mm, height_mm
      FROM products
      WHERE id = $1
      `,
      [id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Изделие не найдено' });
    }

    res.json(rows[0]);
  } catch (err) {
    logError('products/:id', err);
    res.status(500).json({ error: 'Ошибка загрузки карточки изделия' });
  }
});

// !!! ВАЖНО: состав сборки – здесь как раз твоя ошибка была !!!
// GET /api/products/:id/children – дети (состав сборки)
app.get('/api/products/:id/children', async (req, res) => {
  const parentId = Number(req.params.id);
  if (!Number.isInteger(parentId)) {
    return res.status(400).json({ error: 'Некорректный ID сборки' });
  }

  try {
    const { rows } = await pool.query(
      `
      SELECT
        b.id            AS bom_item_id,
        b.quantity      AS quantity,
        p.id,
        p.code,
        p.name,
        p.type,
        p.mass_kg,
        p.length_mm,
        p.width_mm,
        p.height_mm
      FROM bom_items b                          -- ТАБЛИЦА СОСТАВА
      JOIN products p ON p.id = b.child_product_id
      WHERE b.parent_product_id = $1           -- РОДИТЕЛЬСКАЯ СБОРКА
      ORDER BY b.id
      `,
      [parentId]
    );

    res.json(rows);
  } catch (err) {
    logError('products/:id/children', err);
    res.status(500).json({ error: 'Ошибка загрузки состава сборки' });
  }
});

// ---------- CRUD ДЛЯ ПРОДУКТОВ (админ-режим) ----------

// POST /api/products – создать
app.post('/api/products', requireAdmin, async (req, res) => {
  try {
    const {
      code,
      name,
      type,
      mass_kg = null,
      length_mm = null,
      width_mm = null,
      height_mm = null
    } = req.body || {};

    if (!code || !name || !type) {
      return res.status(400).json({ error: 'Не указаны обязательные поля' });
    }

    const { rows } = await pool.query(
      `
      INSERT INTO products (code, name, type, mass_kg, length_mm, width_mm, height_mm)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      RETURNING id, code, name, type, mass_kg, length_mm, width_mm, height_mm
      `,
      [code, name, type, mass_kg, length_mm, width_mm, height_mm]
    );

    res.status(201).json(rows[0]);
  } catch (err) {
    logError('POST /products', err);
    res.status(500).json({ error: 'Ошибка создания изделия' });
  }
});

// PUT /api/products/:id – обновить карточку
app.put('/api/products/:id', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'Некорректный ID' });
  }

  try {
    const {
      code,
      name,
      type,
      mass_kg = null,
      length_mm = null,
      width_mm = null,
      height_mm = null
    } = req.body || {};

    const { rows } = await pool.query(
      `
      UPDATE products
      SET code       = $1,
          name       = $2,
          type       = $3,
          mass_kg    = $4,
          length_mm  = $5,
          width_mm   = $6,
          height_mm  = $7
      WHERE id = $8
      RETURNING id, code, name, type, mass_kg, length_mm, width_mm, height_mm
      `,
      [code, name, type, mass_kg, length_mm, width_mm, height_mm, id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Изделие не найдено' });
    }

    res.json(rows[0]);
  } catch (err) {
    logError('PUT /products/:id', err);
    res.status(500).json({ error: 'Ошибка сохранения изделия' });
  }
});

// DELETE /api/products/:id – удалить изделие и его состав
app.delete('/api/products/:id', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'Некорректный ID' });
  }

  try {
    // удаляем все строки состава, где это изделие родитель или ребёнок
    await pool.query(
      `
      DELETE FROM bom_items
      WHERE parent_product_id = $1
         OR child_product_id  = $1
      `,
      [id]
    );

    const { rowCount } = await pool.query(
      `DELETE FROM products WHERE id = $1`,
      [id]
    );

    if (rowCount === 0) {
      return res.status(404).json({ error: 'Изделие не найдено' });
    }

    res.json({ success: true });
  } catch (err) {
    logError('DELETE /products/:id', err);
    res.status(500).json({ error: 'Ошибка удаления изделия' });
  }
});

// ---------- СОСТАВ СБОРКИ (BOM) – АДМИН ----------

// POST /api/bom – добавить позицию в состав { parentId, childId, quantity }
app.post('/api/bom', requireAdmin, async (req, res) => {
  try {
    const { parentId, childId, quantity = 1 } = req.body || {};
    if (!parentId || !childId) {
      return res.status(400).json({ error: 'Не указан родитель или дочерний элемент' });
    }

    const { rows } = await pool.query(
      `
      INSERT INTO bom_items (parent_product_id, child_product_id, quantity)
      VALUES ($1,$2,$3)
      RETURNING id, parent_product_id, child_product_id, quantity
      `,
      [parentId, childId, quantity]
    );

    res.status(201).json(rows[0]);
  } catch (err) {
    logError('POST /bom', err);
    res.status(500).json({ error: 'Ошибка добавления в состав' });
  }
});

// DELETE /api/bom/:id – удалить строку состава
app.delete('/api/bom/:id', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'Некорректный ID строки состава' });
  }

  try {
    const { rowCount } = await pool.query(
      `DELETE FROM bom_items WHERE id = $1`,
      [id]
    );
    if (rowCount === 0) {
      return res.status(404).json({ error: 'Строка состава не найдена' });
    }
    res.json({ success: true });
  } catch (err) {
    logError('DELETE /bom/:id', err);
    res.status(500).json({ error: 'Ошибка удаления из состава' });
  }
});

// ---------- КОРЗИНА ----------

// GET /api/cart
app.get('/api/cart', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `
      SELECT
        c.id,
        c.quantity,
        p.id        AS product_id,
        p.code,
        p.name
      FROM cart_items c
      JOIN products p ON p.id = c.product_id
      ORDER BY c.id
      `
    );
    res.json(rows);
  } catch (err) {
    logError('GET /cart', err);
    res.status(500).json({ error: 'Ошибка загрузки корзины' });
  }
});

// POST /api/cart – добавить в корзину { productId, quantity }
app.post('/api/cart', async (req, res) => {
  try {
    const { productId, quantity = 1 } = req.body || {};
    if (!productId) {
      return res.status(400).json({ error: 'Не указан productId' });
    }

    const { rows } = await pool.query(
      `
      INSERT INTO cart_items (product_id, quantity)
      VALUES ($1,$2)
      RETURNING id, product_id, quantity
      `,
      [productId, quantity]
    );

    res.status(201).json(rows[0]);
  } catch (err) {
    logError('POST /cart', err);
    res.status(500).json({ error: 'Ошибка добавления в корзину' });
  }
});

// DELETE /api/cart/:id – удалить позицию
app.delete('/api/cart/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'Некорректный ID позиции корзины' });
  }

  try {
    const { rowCount } = await pool.query(
      `DELETE FROM cart_items WHERE id = $1`,
      [id]
    );
    if (rowCount === 0) {
      return res.status(404).json({ error: 'Позиция не найдена' });
    }
    res.json({ success: true });
  } catch (err) {
    logError('DELETE /cart/:id', err);
    res.status(500).json({ error: 'Ошибка удаления из корзины' });
  }
});

// DELETE /api/cart – полностью очистить корзину
app.delete('/api/cart', async (req, res) => {
  try {
    await pool.query(`DELETE FROM cart_items`);
    res.json({ success: true });
  } catch (err) {
    logError('DELETE /cart', err);
    res.status(500).json({ error: 'Ошибка очистки корзины' });
  }
});

// ---------- ЗАПУСК ----------
app.listen(PORT, () => {
  console.log(`API запущен на порту ${PORT}`);
});
