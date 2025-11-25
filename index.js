// index.js
// API каталога для интернета с админ-режимом

const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const pool = require('./db'); // подключение к Postgres (как было в db.js)

const app = express();

// --- базовая настройка ---
app.use(cors());
app.use(express.json());

// --- конфиг админа из переменных окружения Render ---
const ADMIN_USER = process.env.ADMIN_USER;                 // dro.ksv73@gmail.com
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH; // bcrypt-хэш
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';

// ====== вспомогательные функции ======

function createAdminToken(email) {
  return jwt.sign({ sub: 'admin', email }, JWT_SECRET, { expiresIn: '8h' });
}

function requireAdmin(req, res, next) {
  const auth = req.headers['authorization'];
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Требуется авторизация администратора' });
  }

  const token = auth.slice(7);
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.sub !== 'admin') {
      throw new Error('not admin');
    }
    req.admin = payload;
    next();
  } catch (e) {
    console.error('JWT error:', e.message);
    return res.status(401).json({ error: 'Неверный или просроченный токен' });
  }
}

// ====== авторизация администратора ======

app.post('/api/admin/login', async (req, res) => {
  try {
    const { email, password } = req.body;

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

    const token = createAdminToken(email);
    res.json({ token });
  } catch (err) {
    console.error('Admin login error:', err);
    res.status(500).json({ error: 'Ошибка авторизации администратора' });
  }
});

// ====== ЧТЕНИЕ КАТАЛОГА (общедоступно) ======

// Корневые изделия (верхний уровень дерева)
app.get('/api/products/root', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT p.*
         FROM products p
        WHERE NOT EXISTS (
              SELECT 1
                FROM bom_items bi
               WHERE bi.child_product_id = p.id
              )
        ORDER BY p.id`
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Failed to load root products:', err);
    res.status(500).json({ error: 'Failed to load root products' });
  }
});

// Состав изделия
app.get('/api/products/:id/children', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(
      `SELECT bi.id AS bom_item_id,
              bi.quantity,
              p.*
         FROM bom_items bi
         JOIN products p ON p.id = bi.child_product_id
        WHERE bi.parent_product_id = $1
        ORDER BY bi.id`,
      [id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Failed to load children for product', id, err);
    res.status(500).json({ error: 'Ошибка загрузки состава' });
  }
});

// Корзина (как было)
app.get('/api/cart', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT c.id,
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
    console.error('Load cart error:', err);
    res.status(500).json({ error: 'Ошибка загрузки корзины' });
  }
});

// Здесь при необходимости можно оставить существующие POST/DELETE для корзины.

// ====== ОПЕРАЦИИ ДЛЯ АДМИНА (CRUD) ======

// Создать новое изделие
app.post('/api/products', requireAdmin, async (req, res) => {
  const { code, name, type, mass_kg, length_mm, width_mm, height_mm } = req.body;

  try {
    const result = await pool.query(
      `INSERT INTO products
         (code, name, type, mass_kg, length_mm, width_mm, height_mm)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
    RETURNING *`,
      [code, name, type, mass_kg, length_mm, width_mm, height_mm]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Create product error:', err);
    res.status(500).json({ error: 'Ошибка создания изделия' });
  }
});

// Обновить изделие
app.put('/api/products/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { code, name, type, mass_kg, length_mm, width_mm, height_mm } = req.body;

  try {
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
     RETURNING *`,
      [code, name, type, mass_kg, length_mm, width_mm, height_mm, id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Изделие не найдено' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Update product error:', err);
    res.status(500).json({ error: 'Ошибка обновления изделия' });
  }
});

// Удалить изделие (вместе с его связями в составе)
app.delete('/api/products/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;

  try {
    await pool.query('BEGIN');

    // удаляем связи, где изделие участвует
    await pool.query(
      'DELETE FROM bom_items WHERE parent_product_id = $1 OR child_product_id = $1',
      [id]
    );

    const result = await pool.query('DELETE FROM products WHERE id = $1', [id]);

    await pool.query('COMMIT');

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Изделие не найдено' });
    }

    res.json({ success: true });
  } catch (err) {
    await pool.query('ROLLBACK');
    console.error('Delete product error:', err);
    res.status(500).json({ error: 'Ошибка удаления изделия' });
  }
});

// Добавить позицию в состав
app.post('/api/products/:id/children', requireAdmin, async (req, res) => {
  const { id } = req.params; // parent id
  const { child_product_id, quantity } = req.body;

  try {
    const result = await pool.query(
      `INSERT INTO bom_items (parent_product_id, child_product_id, quantity)
       VALUES ($1, $2, $3)
    RETURNING *`,
      [id, child_product_id, quantity]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Add BOM item error:', err);
    res.status(500).json({ error: 'Ошибка добавления позиции состава' });
  }
});

// Обновить количество в составе
app.put('/api/bom-items/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { quantity } = req.body;

  try {
    const result = await pool.query(
      `UPDATE bom_items
          SET quantity = $1
        WHERE id = $2
     RETURNING *`,
      [quantity, id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Позиция состава не найдена' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Update BOM item error:', err);
    res.status(500).json({ error: 'Ошибка обновления позиции состава' });
  }
});

// Удалить позицию состава
app.delete('/api/bom-items/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;

  try {
    const result = await pool.query(
      'DELETE FROM bom_items WHERE id = $1',
      [id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Позиция состава не найдена' });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Delete BOM item error:', err);
    res.status(500).json({ error: 'Ошибка удаления позиции состава' });
  }
});

// ====== запуск сервера ======

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`catalog-api listening on port ${PORT}`);
});
