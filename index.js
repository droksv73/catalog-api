// index.js
//
// Сервер для "Каталога деталей крана КС-8165".
// Express + PostgreSQL + JWT + загрузка файлов + статистика хранилища.
//
// Таблицы, на которые он рассчитан:
//
// products(
//   id serial primary key,
//   code text,
//   name text,
//   type text,          -- 'Assembly' | 'Part' | 'Standard'
//   mass_kg numeric,
//   length_mm numeric,
//   width_mm numeric,
//   height_mm numeric
// )
//
// bom_items(
//   id serial primary key,
//   parent_id integer references products(id),
//   product_id integer references products(id),
//   quantity numeric
// )
//
// cart_items(
//   id serial primary key,
//   product_id integer references products(id),
//   quantity numeric
// )
//
// admins(
//   id serial primary key,
//   email text,
//   password_hash text,
//   is_admin boolean
// )

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

// --------- НАСТРОЙКИ ---------

const PORT = process.env.PORT || 10000;
const JWT_SECRET = process.env.JWT_SECRET || 'change_me_secret';

// Каталог для загруженных 2D/3D файлов
const UPLOAD_ROOT = path.join(__dirname, 'uploads');
// Лимит хранилища: 2 ГиБ
const STORAGE_LIMIT_BYTES = 2 * 1024 * 1024 * 1024;

if (!fs.existsSync(UPLOAD_ROOT)) {
  fs.mkdirSync(UPLOAD_ROOT, { recursive: true });
}

// --------- PostgreSQL ---------

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

// --------- МИДЛВАРЫ ---------

app.use(cors());
app.use(express.json());

// Раздаём загруженные файлы
app.use('/uploads', express.static(UPLOAD_ROOT));

// Multer — сохранение файлов на диск
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_ROOT),
  filename: (req, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, `${unique}-${safe}`);
  },
});
const upload = multer({ storage });

// --------- ВСПОМОГАТЕЛЬНЫЕ ---------

function generateToken(adminRow) {
  return jwt.sign(
    {
      id: adminRow.id,
      email: adminRow.email,
      isAdmin: adminRow.is_admin,
    },
    JWT_SECRET,
    { expiresIn: '12h' }
  );
}

function authRequired(req, res, next) {
  const auth = req.headers.authorization || '';
  const [, token] = auth.split(' ');
  if (!token) return res.status(401).json({ error: 'No token' });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    return next();
  } catch (e) {
    console.error('JWT error:', e.message);
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
      if (e.code === 'ENOENT') return;
      throw e;
    }

    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        const st = await fs.promises.stat(full);
        totalBytes += st.size;
        fileCount += 1;
      }
    }
  }

  await walk(dir);
  return { totalBytes, fileCount };
}

// --------- АВТОРИЗАЦИЯ АДМИНА ---------
//
// POST /api/auth/login
// body: { username, password }  (username = email в таблице admins)

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

    const admin = rows[0];
    const ok = await bcrypt.compare(password, admin.password_hash);
    if (!ok) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = generateToken(admin);
    res.json({ token });
  } catch (e) {
    console.error('login error', e);
    res.status(500).json({ error: 'Login failed' });
  }
});

// --------- ИЗДЕЛИЯ ---------
//
// Важно: здесь /api/products/root просто отдаёт ВСЕ изделия,
// а уже фронтенд решает, что показывать отдельно, а что только как подсборку.

app.get('/api/products/root', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `
      SELECT
        id,
        code,
        name,
        type,
        mass_kg,
        length_mm,
        width_mm,
        height_mm
      FROM products
      ORDER BY code
      `
    );
    res.json(rows);
  } catch (e) {
    console.error('root products error', e);
    res.status(500).json({ error: 'Failed to load root products' });
  }
});

// Карточка изделия
app.get('/api/products/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const { rows } = await pool.query(
      `
      SELECT
        id,
        code,
        name,
        type,
        mass_kg,
        length_mm,
        width_mm,
        height_mm
      FROM products
      WHERE id = $1
      `,
      [id]
    );

    if (!rows.length) {
      return res.status(404).json({ error: 'Product not found' });
    }

    res.json(rows[0]);
  } catch (e) {
    console.error('product error', e);
    res.status(500).json({ error: 'Failed to load product' });
  }
});

// Состав сборки
// products.id = bom_items.product_id
app.get('/api/products/:id/children', async (req, res) => {
  const { id } = req.params;
  try {
    const { rows } = await pool.query(
      `
      SELECT
        b.id       AS bom_item_id,
        b.quantity AS quantity,
        p.id       AS product_id,
        p.code,
        p.name,
        p.type,
        p.mass_kg,
        p.length_mm,
        p.width_mm,
        p.height_mm
      FROM bom_items b
      JOIN products p ON p.id = b.product_id
      WHERE b.parent_id = $1
      ORDER BY p.code
      `,
      [id]
    );
    res.json(rows);
  } catch (e) {
    console.error('children error', e);
    res.status(500).json({ error: 'Failed to load children' });
  }
});

// Создание изделия (только админ)
// body: { code, name, type, mass_kg, length_mm, width_mm, height_mm, parentId, quantityInParent }
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
    return res.status(400).json({ error: 'Code, name and type are required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const insertProdSql = `
      INSERT INTO products (code, name, type, mass_kg, length_mm, width_mm, height_mm)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      RETURNING
        id,
        code,
        name,
        type,
        mass_kg,
        length_mm,
        width_mm,
        height_mm
    `;

    const { rows } = await client.query(insertProdSql, [
      code,
      name,
      type,
      mass_kg ?? null,
      length_mm ?? null,
      width_mm ?? null,
      height_mm ?? null,
    ]);

    const product = rows[0];

    // Если задан parentId — добавляем строку в BOM
    if (parentId) {
      const qty =
        quantityInParent && Number(quantityInParent) > 0
          ? Number(quantityInParent)
          : 1;

      await client.query(
        `
        INSERT INTO bom_items (parent_id, product_id, quantity)
        VALUES ($1,$2,$3)
        `,
        [parentId, product.id, qty]
      );
    }

    await client.query('COMMIT');
    res.status(201).json(product);
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('create product error', e);
    res.status(500).json({ error: 'Failed to create product' });
  } finally {
    client.release();
  }
});

// Обновление изделия (только админ)
app.put('/api/products/:id', authRequired, async (req, res) => {
  if (!req.user || !req.user.isAdmin) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const { id } = req.params;
  const {
    code,
    name,
    type,
    mass_kg,
    length_mm,
    width_mm,
    height_mm,
  } = req.body || {};

  try {
    const { rows } = await pool.query(
      `
      UPDATE products
      SET
        code      = $1,
        name      = $2,
        type      = $3,
        mass_kg   = $4,
        length_mm = $5,
        width_mm  = $6,
        height_mm = $7
      WHERE id   = $8
      RETURNING
        id,
        code,
        name,
        type,
        mass_kg,
        length_mm,
        width_mm,
        height_mm
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

    res.json(rows[0]);
  } catch (e) {
    console.error('update product error', e);
    res.status(500).json({ error: 'Failed to update product' });
  }
});

// Удаление позиции BOM
app.delete('/api/bom/:id', authRequired, async (req, res) => {
  if (!req.user || !req.user.isAdmin) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const { id } = req.params;
  try {
    await pool.query('DELETE FROM bom_items WHERE id = $1', [id]);
    res.json({ ok: true });
  } catch (e) {
    console.error('delete bom error', e);
    res.status(500).json({ error: 'Failed to delete bom item' });
  }
});

// --------- ЗАГРУЗКА ФАЙЛОВ 2D/3D ---------
//
// POST /api/products/:id/media
// form-data: file=<file>, kind=image|model
//
// ВНИМАНИЕ: этот эндпоинт пока НЕ пишет ничего в БД,
// он только сохраняет файл на диске и возвращает URL.
// При перезагрузке страницы фронт про этот файл не знает —
// полноценная привязка файла к изделию требует доработки схемы БД.

app.post(
  '/api/products/:id/media',
  authRequired,
  upload.single('file'),
  async (req, res) => {
    if (!req.user || !req.user.isAdmin) {
      if (req.file) fs.unlink(req.file.path, () => {});
      return res.status(403).json({ error: 'Forbidden' });
    }

    const { kind } = req.body || {};
    if (!req.file || !kind) {
      if (req.file) fs.unlink(req.file.path, () => {});
      return res.status(400).json({ error: 'file and kind are required' });
    }

    if (kind !== 'image' && kind !== 'model') {
      if (req.file) fs.unlink(req.file.path, () => {});
      return res.status(400).json({ error: 'kind must be image or model' });
    }

    // Просто отдаём URL сохранённого файла
    const url = `/uploads/${req.file.filename}`;
    res.json({ url, kind });
  }
);

// --------- КОРЗИНА ---------

// GET /api/cart
app.get('/api/cart', async (req, res) => {
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
    res.json(rows);
  } catch (e) {
    console.error('cart get error', e);
    res.status(500).json({ error: 'Failed to load cart' });
  }
});

// POST /api/cart/add { productId, quantity }
app.post('/api/cart/add', async (req, res) => {
  const { productId, quantity } = req.body || {};
  if (!productId) {
    return res.status(400).json({ error: 'productId required' });
  }

  const qty = quantity && Number(quantity) > 0 ? Number(quantity) : 1;

  try {
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

    res.json({ ok: true });
  } catch (e) {
    console.error('cart add error', e);
    res.status(500).json({ error: 'Failed to add to cart' });
  }
});

// DELETE /api/cart/:id
app.delete('/api/cart/:id', async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query('DELETE FROM cart_items WHERE id = $1', [id]);
    res.json({ ok: true });
  } catch (e) {
    console.error('cart delete error', e);
    res.status(500).json({ error: 'Failed to delete from cart' });
  }
});

// --------- АДМИН: СТАТИСТИКА ХРАНИЛИЩА ---------
//
// GET /api/admin/storage  (только админ)

app.get('/api/admin/storage', authRequired, async (req, res) => {
  try {
    if (!req.user || !req.user.isAdmin) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const { totalBytes, fileCount } = await getDirStats(UPLOAD_ROOT);
    const used = totalBytes;
    const limit = STORAGE_LIMIT_BYTES;
    const available = Math.max(0, limit - used);

    res.json({
      totalFiles: fileCount,
      totalBytesUsed: used,
      totalBytesLimit: limit,
      totalBytesAvailable: available,
    });
  } catch (e) {
    console.error('storage stats error', e);
    res.status(500).json({ error: 'Failed to read storage stats' });
  }
});

// --------- ПРОВЕРОЧНЫЙ РУТ ---------

app.get('/', (req, res) => {
  res.send('API is running');
});

// --------- СТАРТ СЕРВЕРА ---------

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
