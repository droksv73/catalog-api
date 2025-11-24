// index.js
//
// Сервер каталога изделий.
// Использует PostgreSQL, JWT-авторизацию, загрузку файлов и даёт статистику по хранилищу.

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();

// ====== НАСТРОЙКИ ======
const PORT = process.env.PORT || 10000;
const JWT_SECRET = process.env.JWT_SECRET || 'change_me_secret';

// Каталог, где храним загруженные файлы (2D/3D)
const UPLOAD_ROOT = path.join(__dirname, 'uploads');
// Лимит хранилища — пример: 2 ГиБ
const STORAGE_LIMIT_BYTES = 2 * 1024 * 1024 * 1024;

// Создаём каталог, если нет
if (!fs.existsSync(UPLOAD_ROOT)) {
  fs.mkdirSync(UPLOAD_ROOT, { recursive: true });
}

// ====== PostgreSQL ======
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL
    ? { rejectUnauthorized: false }
    : false,
});

// ====== Мидлвары ======
app.use(cors());
app.use(express.json());

// Раздаём файлы из uploads по /uploads/...
app.use('/uploads', express.static(UPLOAD_ROOT));

// Для загрузки файлов (2D/3D)
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOAD_ROOT);
  },
  filename: (req, file, cb) => {
    const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, unique + '-' + safeName);
  },
});

const upload = multer({ storage });

// ====== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ======
function generateToken(user) {
  return jwt.sign(
    {
      id: user.id,
      email: user.email,
      isAdmin: user.is_admin,
    },
    JWT_SECRET,
    { expiresIn: '12h' }
  );
}

function authRequired(req, res, next) {
  const auth = req.headers.authorization || '';
  const [, token] = auth.split(' ');

  if (!token) {
    return res.status(401).json({ error: 'No token' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    return next();
  } catch (e) {
    console.error('JWT error', e.message);
    return res.status(401).json({ error: 'Invalid token' });
  }
}

async function getDirStats(dir) {
  let totalBytes = 0;
  let fileCount = 0;

  async function walk(current) {
    let entries;
    try {
      entries = await fs.promises.readdir(current, { withFileTypes: true });
    } catch (e) {
      // каталога нет — просто 0
      if (e.code === 'ENOENT') return;
      throw e;
    }

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        const stat = await fs.promises.stat(fullPath);
        totalBytes += stat.size;
        fileCount += 1;
      }
    }
  }

  await walk(dir);
  return { totalBytes, fileCount };
}

// ====== АВТОРИЗАЦИЯ ======

// POST /api/auth/login { username, password }
app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }

  try {
    const { rows } = await pool.query(
      'SELECT id, email, password_hash, is_admin FROM admins WHERE email = $1',
      [username]
    );
    if (!rows.length) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const user = rows[0];

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = generateToken(user);
    return res.json({ token });
  } catch (e) {
    console.error('login error', e);
    return res.status(500).json({ error: 'Login failed' });
  }
});

// ====== ПРОДУКТЫ ======

/**
 * /api/products/root
 * Отдаёт изделия верхнего уровня (которые не являются дочерними ни у кого)
 */
app.get('/api/products/root', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `
      SELECT p.*
      FROM products p
      LEFT JOIN bom_items b ON b.child_id = p.id
      WHERE b.id IS NULL
      ORDER BY p.code
      `
    );
    return res.json(rows);
  } catch (e) {
    console.error('root products error', e);
    return res.status(500).json({ error: 'Failed to load root products' });
  }
});

/**
 * /api/products/:id
 * Детальная карточка изделия
 */
app.get('/api/products/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const { rows } = await pool.query('SELECT * FROM products WHERE id = $1', [
      id,
    ]);
    if (!rows.length) {
      return res.status(404).json({ error: 'Product not found' });
    }
    return res.json(rows[0]);
  } catch (e) {
    console.error('product error', e);
    return res.status(500).json({ error: 'Failed to load product' });
  }
});

/**
 * /api/products/:id/children
 * Состав сборки (BOM)
 */
app.get('/api/products/:id/children', async (req, res) => {
  const { id } = req.params;
  try {
    const { rows } = await pool.query(
      `
      SELECT
        b.id       AS bom_item_id,
        b.quantity AS quantity,
        p.id,
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
      ORDER BY p.code
      `,
      [id]
    );
    return res.json(rows);
  } catch (e) {
    console.error('children error', e);
    return res.status(500).json({ error: 'Failed to load children' });
  }
});

/**
 * POST /api/products
 * Добавление нового изделия (только админ).
 * При parentId и quantityInParent создаёт запись в BOM.
 */
app.post('/api/products', authRequired, async (req, res) => {
  if (!req.user || !req.user.isAdmin) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const {
    code,
    name,
    type,
    mass_kg,
    length_mm,
    width_mm,
    height_mm,
    parentId,
    quantityInParent,
  } = req.body || {};

  if (!code || !name || !type) {
    return res.status(400).json({ error: 'Code, name, type required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const insertProduct = `
      INSERT INTO products (code, name, type, mass_kg, length_mm, width_mm, height_mm)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      RETURNING *
    `;
    const { rows } = await client.query(insertProduct, [
      code,
      name,
      type,
      mass_kg ?? null,
      length_mm ?? null,
      width_mm ?? null,
      height_mm ?? null,
    ]);
    const product = rows[0];

    if (parentId) {
      const qty = quantityInParent ?? 1;
      await client.query(
        `
        INSERT INTO bom_items (parent_id, child_id, quantity)
        VALUES ($1,$2,$3)
        `,
        [parentId, product.id, qty]
      );
    }

    await client.query('COMMIT');
    return res.status(201).json(product);
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('create product error', e);
    return res.status(500).json({ error: 'Failed to create product' });
  } finally {
    client.release();
  }
});

/**
 * PUT /api/products/:id
 * Обновление карточки (только админ)
 */
app.put('/api/products/:id', authRequired, async (req, res) => {
  if (!req.user || !req.user.isAdmin) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const { id } = req.params;
  const { code, name, type, mass_kg, length_mm, width_mm, height_mm } =
    req.body || {};

  try {
    const { rows } = await pool.query(
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
      RETURNING *
      `,
      [
        code,
        name,
        type,
        mass_kg ?? null,
        length_mm ?? null,
        width_mm ?? null,
        height_mm ?? null,
        id,
      ]
    );

    if (!rows.length) {
      return res.status(404).json({ error: 'Product not found' });
    }
    return res.json(rows[0]);
  } catch (e) {
    console.error('update product error', e);
    return res.status(500).json({ error: 'Failed to update product' });
  }
});

// Удаление позиции из BOM
app.delete('/api/bom/:id', authRequired, async (req, res) => {
  if (!req.user || !req.user.isAdmin) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const { id } = req.params;
  try {
    await pool.query('DELETE FROM bom_items WHERE id = $1', [id]);
    return res.json({ ok: true });
  } catch (e) {
    console.error('delete bom error', e);
    return res.status(500).json({ error: 'Failed to delete bom item' });
  }
});

// ====== ЗАГРУЗКА ФАЙЛОВ 2D/3D ======

/**
 * POST /api/products/:id/media
 * form-data: file (бинарный), kind=image|model
 * Только админ.
 */
app.post(
  '/api/products/:id/media',
  authRequired,
  upload.single('file'),
  async (req, res) => {
    if (!req.user || !req.user.isAdmin) {
      // удаляем загруженный файл
      if (req.file) {
        fs.unlink(req.file.path, () => {});
      }
      return res.status(403).json({ error: 'Forbidden' });
    }

    const { id } = req.params;
    const { kind } = req.body || {};
    if (!req.file || !kind) {
      if (req.file) {
        fs.unlink(req.file.path, () => {});
      }
      return res.status(400).json({ error: 'file and kind required' });
    }

    if (kind !== 'image' && kind !== 'model') {
      fs.unlink(req.file.path, () => {});
      return res.status(400).json({ error: 'kind must be image or model' });
    }

    const url = `/uploads/${req.file.filename}`;

    try {
      if (kind === 'image') {
        await pool.query(
          'UPDATE products SET image_url = $1 WHERE id = $2',
          [url, id]
        );
      } else {
        await pool.query(
          'UPDATE products SET model_url = $1 WHERE id = $2',
          [url, id]
        );
      }
      return res.json({ url });
    } catch (e) {
      console.error('media update error', e);
      fs.unlink(req.file.path, () => {});
      return res.status(500).json({ error: 'Failed to save media' });
    }
  }
);

// ====== КОРЗИНА (простая, без пользователей) ======

app.get('/api/cart', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `
      SELECT
        c.id,
        c.product_id,
        c.quantity,
        p.code,
        p.name
      FROM cart_items c
      JOIN products p ON p.id = c.product_id
      ORDER BY c.id
      `
    );
    return res.json(rows);
  } catch (e) {
    console.error('cart get error', e);
    return res.status(500).json({ error: 'Failed to load cart' });
  }
});

app.post('/api/cart/add', async (req, res) => {
  const { productId, quantity } = req.body || {};
  if (!productId) {
    return res.status(400).json({ error: 'productId required' });
  }
  const qty = quantity && Number(quantity) > 0 ? Number(quantity) : 1;

  try {
    // если уже есть такая позиция, просто добавим количество
    const { rows } = await pool.query(
      'SELECT id, quantity FROM cart_items WHERE product_id = $1',
      [productId]
    );
    if (rows.length) {
      const current = Number(rows[0].quantity) || 0;
      await pool.query(
        'UPDATE cart_items SET quantity = $1 WHERE id = $2',
        [current + qty, rows[0].id]
      );
    } else {
      await pool.query(
        'INSERT INTO cart_items (product_id, quantity) VALUES ($1,$2)',
        [productId, qty]
      );
    }
    return res.json({ ok: true });
  } catch (e) {
    console.error('cart add error', e);
    return res.status(500).json({ error: 'Failed to add to cart' });
  }
});

app.delete('/api/cart/:id', async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query('DELETE FROM cart_items WHERE id = $1', [id]);
    return res.json({ ok: true });
  } catch (e) {
    console.error('cart delete error', e);
    return res.status(500).json({ error: 'Failed to delete from cart' });
  }
});

// ====== АДМИН: СТАТИСТИКА ПО ХРАНИЛИЩУ ======

app.get('/api/admin/storage', authRequired, async (req, res) => {
  try {
    if (!req.user || !req.user.isAdmin) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const { totalBytes, fileCount } = await getDirStats(UPLOAD_ROOT);
    const used = totalBytes;
    const limit = STORAGE_LIMIT_BYTES;
    const available = Math.max(0, limit - used);

    return res.json({
      totalFiles: fileCount,
      totalBytesUsed: used,
      totalBytesLimit: limit,
      totalBytesAvailable: available,
    });
  } catch (e) {
    console.error('storage stats error', e);
    return res.status(500).json({ error: 'Failed to read storage stats' });
  }
});

// ====== ЗАПУСК ======
app.get('/', (_req, res) => {
  res.send('API is running');
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});

/*
Примерная схема БД (подправь под свою):

CREATE TABLE admins (
  id            serial PRIMARY KEY,
  email         text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  is_admin      boolean NOT NULL DEFAULT true
);

CREATE TABLE products (
  id         serial PRIMARY KEY,
  code       text NOT NULL,
  name       text NOT NULL,
  type       text NOT NULL,        -- 'Assembly' | 'Part' | 'Standard'
  mass_kg    numeric,
  length_mm  numeric,
  width_mm   numeric,
  height_mm  numeric,
  image_url  text,
  model_url  text
);

CREATE TABLE bom_items (
  id         serial PRIMARY KEY,
  parent_id  int NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  child_id   int NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  quantity   numeric NOT NULL DEFAULT 1
);

CREATE TABLE cart_items (
  id         serial PRIMARY KEY,
  product_id int NOT NULL REFERENCES products(id),
  quantity   numeric NOT NULL DEFAULT 1
);
*/
