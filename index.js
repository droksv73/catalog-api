// index.js – API для каталога крана КС-8165 (интернет-версия)

import express from 'express';
import cors from 'cors';
import pkg from 'pg';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';

const { Pool } = pkg;

const app = express();
const PORT = process.env.PORT || 10000;

// ---------- ПУТИ ----------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

// раздаём загруженные файлы
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// маленький хелпер для логов
function logError(place, err) {
  console.error(`[${place}]`, err.message, err.stack);
}

// ---------- АУТЕНТИФИКАЦИЯ АДМИНА ----------

const ADMIN_USER = process.env.ADMIN_USER || 'admin@example.com';
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

    if (!ADMIN_PASSWORD_HASH) {
      return res.status(500).json({ error: 'Пароль администратора не настроен' });
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

// мидлвар для эндпоинтов, где нужны админ-права
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

const PRODUCT_FIELDS = `
  p.id,
  p.code,
  p.name,
  p.type,
  p.mass_kg,
  p.length_mm,
  p.width_mm,
  p.height_mm,
  p.image2d_url,
  p.model3d_url
`;

// GET /api/products/root – элементы верхнего уровня дерева
app.get('/api/products/root', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `
      SELECT ${PRODUCT_FIELDS}
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
    res.status(500).json({ error: 'Ошибка загрузки дерева изделий' });
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
      SELECT ${PRODUCT_FIELDS}
      FROM products p
      WHERE p.id = $1
      `,
      [id]
    );
    if (!rows.length) {
      return res.status(404).json({ error: 'Изделие не найдено' });
    }
    res.json(rows[0]);
  } catch (err) {
    logError('products/:id', err);
    res.status(500).json({ error: 'Ошибка загрузки карточки изделия' });
  }
});

// GET /api/products/:id/children – состав сборки
app.get('/api/products/:id/children', async (req, res) => {
  const parentId = Number(req.params.id);
  if (!Number.isInteger(parentId)) {
    return res.status(400).json({ error: 'Некорректный ID сборки' });
  }

  try {
    const { rows } = await pool.query(
      `
      SELECT
        b.id,
        b.parent_product_id,
        b.child_product_id AS product_id,
        b.quantity,
        p.code,
        p.name,
        p.type,
        p.mass_kg,
        p.length_mm,
        p.width_mm,
        p.height_mm,
        p.image2d_url,
        p.model3d_url
      FROM bom_items b
      JOIN products p ON p.id = b.child_product_id
      WHERE b.parent_product_id = $1
      ORDER BY b.id
      `,
      [parentId]
    );
    res.json(rows);
  } catch (err) {
    logError('products/:id/children', err);
    res.status(500).json({ error: 'Ошибка загрузки состава' });
  }
});

// POST /api/products – создать изделие
app.post('/api/products', requireAdmin, async (req, res) => {
  try {
    const {
      code,
      name,
      type,
      mass_kg = null,
      length_mm = null,
      width_mm = null,
      height_mm = null,
      image2d_url = null,
      model3d_url = null
    } = req.body || {};

    if (!code || !name || !type) {
      return res.status(400).json({ error: 'Не заполнены обязательные поля (код, наименование, тип)' });
    }

    const { rows } = await pool.query(
      `
      INSERT INTO products
        (code, name, type, mass_kg, length_mm, width_mm, height_mm, image2d_url, model3d_url)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      RETURNING ${PRODUCT_FIELDS}
      `,
      [code, name, type, mass_kg, length_mm, width_mm, height_mm, image2d_url, model3d_url]
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
      code = null,
      name = null,
      type = null,
      mass_kg = null,
      length_mm = null,
      width_mm = null,
      height_mm = null,
      image2d_url = null,
      model3d_url = null
    } = req.body || {};

    const { rows } = await pool.query(
      `
      UPDATE products
      SET
        code        = COALESCE($1, code),
        name        = COALESCE($2, name),
        type        = COALESCE($3, type),
        mass_kg     = COALESCE($4, mass_kg),
        length_mm   = COALESCE($5, length_mm),
        width_mm    = COALESCE($6, width_mm),
        height_mm   = COALESCE($7, height_mm),
        image2d_url = COALESCE($8, image2d_url),
        model3d_url = COALESCE($9, model3d_url)
      WHERE id = $10
      RETURNING ${PRODUCT_FIELDS}
      `,
      [code, name, type, mass_kg, length_mm, width_mm, height_mm, image2d_url, model3d_url, id]
    );

    if (!rows.length) {
      return res.status(404).json({ error: 'Изделие не найдено' });
    }

    res.json(rows[0]);
  } catch (err) {
    logError('PUT /products/:id', err);
    res.status(500).json({ error: 'Ошибка обновления изделия' });
  }
});

// DELETE /api/products/:id – удалить изделие и связи
app.delete('/api/products/:id', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'Некорректный ID' });
  }

  try {
    await pool.query('DELETE FROM bom_items WHERE parent_product_id = $1 OR child_product_id = $1', [id]);
    await pool.query('DELETE FROM cart_items WHERE product_id = $1', [id]);

    const { rows } = await pool.query(
      `
      DELETE FROM products
      WHERE id = $1
      RETURNING ${PRODUCT_FIELDS}
      `,
      [id]
    );

    if (!rows.length) {
      return res.status(404).json({ error: 'Изделие не найдено' });
    }

    res.json(rows[0]);
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

// DELETE /api/bom/:id – удалить строку из состава
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
    if (!rowCount) {
      return res.status(404).json({ error: 'Строка состава не найдена' });
    }
    res.json({ success: true });
  } catch (err) {
    logError('DELETE /bom/:id', err);
    res.status(500).json({ error: 'Ошибка удаления строки состава' });
  }
});

// ---------- КОРЗИНА ----------

// GET /api/cart – список позиций (с данными изделия)
app.get('/api/cart', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `
      SELECT
        c.id,
        c.quantity,
        p.id   AS product_id,
        p.code,
        p.name,
        p.mass_kg,
        p.length_mm,
        p.width_mm,
        p.height_mm
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

// Базовый POST /api/cart – добавить позицию
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

// Алиас под фронтенд: POST /api/cart/add
app.post('/api/cart/add', async (req, res) => {
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
    logError('POST /cart/add', err);
    res.status(500).json({ error: 'Ошибка добавления в корзину' });
  }
});

// DELETE /api/cart/:id – удалить строку
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
    if (!rowCount) {
      return res.status(404).json({ error: 'Позиция корзины не найдена' });
    }
    res.json({ success: true });
  } catch (err) {
    logError('DELETE /cart/:id', err);
    res.status(500).json({ error: 'Ошибка удаления позиции корзины' });
  }
});

// DELETE /api/cart – очистить корзину
app.delete('/api/cart', async (req, res) => {
  try {
    await pool.query(`DELETE FROM cart_items`);
    res.json({ success: true });
  } catch (err) {
    logError('DELETE /cart', err);
    res.status(500).json({ error: 'Ошибка очистки корзины' });
  }
});

// Алиас под фронтенд: DELETE /api/cart/clear
app.delete('/api/cart/clear', async (req, res) => {
  try {
    await pool.query(`DELETE FROM cart_items`);
    res.json({ success: true });
  } catch (err) {
    logError('DELETE /cart/clear', err);
    res.status(500).json({ error: 'Ошибка очистки корзины' });
  }
});

// ---------- ЗАКАЗЫ ----------
// Ожидаются таблицы:
//  orders(id serial PK, created_at timestamptz default now(), customer_name, customer_email, customer_phone, order_number, comment)
//  order_items(id serial PK, order_id int FK, product_id int FK, quantity int)

app.post('/api/orders', async (req, res) => {
  const {
    customer_name = null,
    customer_email = null,
    customer_phone = null,
    order_number = null,
    comment = null
  } = req.body || {};

  if (!customer_name || (!customer_email && !customer_phone)) {
    return res.status(400).json({ error: 'Необходимо указать заказчика и контакты (телефон или email)' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: cartItems } = await client.query(
      `
      SELECT product_id, quantity
      FROM cart_items
      ORDER BY id
      `
    );

    if (!cartItems.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Корзина пуста' });
    }

    const generatedNumber =
      order_number ||
      'ORD-' + Math.floor(Date.now() / 1000).toString();

    const { rows: orderRows } = await client.query(
      `
      INSERT INTO orders
        (customer_name, customer_email, customer_phone, order_number, comment)
      VALUES ($1,$2,$3,$4,$5)
      RETURNING id, created_at, customer_name, customer_email, customer_phone, order_number, comment
      `,
      [customer_name, customer_email, customer_phone, generatedNumber, comment]
    );
    const order = orderRows[0];

    for (const item of cartItems) {
      await client.query(
        `
        INSERT INTO order_items (order_id, product_id, quantity)
        VALUES ($1,$2,$3)
        `,
        [order.id, item.product_id, item.quantity]
      );
    }

    await client.query('DELETE FROM cart_items');
    await client.query('COMMIT');

    res.status(201).json({ order, items: cartItems });
  } catch (err) {
    await client.query('ROLLBACK');
    logError('POST /orders', err);
    res.status(500).json({ error: 'Ошибка оформления заказа' });
  } finally {
    client.release();
  }
});

// Опционально: просмотр одного заказа
app.get('/api/orders/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'Некорректный ID заказа' });
  }

  try {
    const { rows: orderRows } = await pool.query(
      `
      SELECT id, created_at, customer_name, customer_email, customer_phone, order_number, comment
      FROM orders
      WHERE id = $1
      `,
      [id]
    );
    if (!orderRows.length) {
      return res.status(404).json({ error: 'Заказ не найден' });
    }

    const { rows: itemRows } = await pool.query(
      `
      SELECT
        oi.id,
        oi.product_id,
        oi.quantity,
        p.code,
        p.name
      FROM order_items oi
      JOIN products p ON p.id = oi.product_id
      WHERE oi.order_id = $1
      ORDER BY oi.id
      `,
      [id]
    );

    res.json({ order: orderRows[0], items: itemRows });
  } catch (err) {
    logError('GET /orders/:id', err);
    res.status(500).json({ error: 'Ошибка загрузки заказа' });
  }
});

// ---------- ЗАГРУЗКА ФАЙЛОВ (2D/3D) ----------

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, path.join(__dirname, 'uploads'));
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const base = path.basename(file.originalname, ext).replace(/\s+/g, '_');
    cb(null, `${Date.now()}_${base}${ext}`);
  }
});

const upload = multer({ storage });

// POST /api/products/:id/image2d – загрузка 2D изображения
app.post('/api/products/:id/image2d', requireAdmin, upload.single('file'), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'Некорректный ID' });
  }
  if (!req.file) {
    return res.status(400).json({ error: 'Файл не передан' });
  }

  const url = `/uploads/${req.file.filename}`;

  try {
    const { rows } = await pool.query(
      `
      UPDATE products
      SET image2d_url = $1
      WHERE id = $2
      RETURNING ${PRODUCT_FIELDS}
      `,
      [url, id]
    );
    if (!rows.length) {
      return res.status(404).json({ error: 'Изделие не найдено' });
    }
    res.json(rows[0]);
  } catch (err) {
    logError('POST /products/:id/image2d', err);
    res.status(500).json({ error: 'Ошибка сохранения 2D изображения' });
  }
});

// POST /api/products/:id/model3d – загрузка 3D модели
app.post('/api/products/:id/model3d', requireAdmin, upload.single('file'), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'Некорректный ID' });
  }
  if (!req.file) {
    return res.status(400).json({ error: 'Файл не передан' });
  }

  const url = `/uploads/${req.file.filename}`;

  try {
    const { rows } = await pool.query(
      `
      UPDATE products
      SET model3d_url = $1
      WHERE id = $2
      RETURNING ${PRODUCT_FIELDS}
      `,
      [url, id]
    );
    if (!rows.length) {
      return res.status(404).json({ error: 'Изделие не найдено' });
    }
    res.json(rows[0]);
  } catch (err) {
    logError('POST /products/:id/model3d', err);
    res.status(500).json({ error: 'Ошибка сохранения 3D модели' });
  }
});

// ---------- ЗАПУСК ----------
app.listen(PORT, () => {
  console.log(`API запущен на порту ${PORT}`);
});
