// index.js
// Catalog API: дерево изделий (BOM) + корзина + медиа + авторизация

const express = require('express');
const cors = require('cors');
const db = require('./db');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

// ---------- КОНФИГ ----------

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH || ''; // задай в ENV
const MAX_STORAGE_MB = Number(process.env.MAX_STORAGE_MB || '500'); // лимит хранилища

const UPLOAD_ROOT = path.join(__dirname, 'uploads');
const IMAGE_DIR = path.join(UPLOAD_ROOT, 'images');
const MODEL_DIR = path.join(UPLOAD_ROOT, 'models');

for (const dir of [UPLOAD_ROOT, IMAGE_DIR, MODEL_DIR]) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// ---------- EXPRESS ----------

const app = express();
app.use(cors());
app.use(express.json());

// статические файлы
app.use('/media/images', express.static(IMAGE_DIR));
app.use('/media/models', express.static(MODEL_DIR));

// ---------- ВСПОМОГАЮЩИЕ ----------

function numOrNull(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function getMaxBytes() {
  return MAX_STORAGE_MB * 1024 * 1024;
}

async function getUsedBytes() {
  const res = await db.query(
    'SELECT COALESCE(SUM(size_bytes), 0) AS sum FROM media_files'
  );
  return Number(res.rows[0].sum || 0);
}

function createToken(username) {
  return jwt.sign(
    { username, role: 'admin' },
    JWT_SECRET,
    { expiresIn: '8h' }
  );
}

function requireAdmin(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.role !== 'admin') {
      return res.status(403).json({ error: 'Forbidden' });
    }
    req.user = payload;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// multer для загрузки файлов
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const kind = req.params.kind === 'model' ? 'model' : 'image';
    cb(null, kind === 'model' ? MODEL_DIR : IMAGE_DIR);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '';
    const base = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, base + ext);
  }
});

const upload = multer({ storage });

// ---------- ИНИЦИАЛИЗАЦИЯ БД ----------

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
      child_product_id  INT NOT NULL REFERENCES products(id),
      quantity          NUMERIC(10,3) NOT NULL
    );
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS cart_items (
      id SERIAL PRIMARY KEY,
      product_id INT NOT NULL REFERENCES products(id),
      quantity  NUMERIC(10,3) NOT NULL
    );
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS media_files (
      id SERIAL PRIMARY KEY,
      product_id INT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      kind VARCHAR(10) NOT NULL,     -- 'image' | 'model'
      filename VARCHAR(255) NOT NULL,
      mime_type VARCHAR(100) NOT NULL,
      size_bytes BIGINT NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
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

// ---------- СЛУЖЕБНЫЕ ----------

app.get('/', (req, res) => {
  res.send('Catalog API is running');
});

// ---------- АВТОРИЗАЦИЯ ----------

app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'username and password required' });
  }
  if (username !== ADMIN_USER || !ADMIN_PASSWORD_HASH) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  const ok = await bcrypt.compare(password, ADMIN_PASSWORD_HASH);
  if (!ok) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  const token = createToken(username);
  res.json({ token });
});

// ---------- КАТАЛОГ: ИЗДЕЛИЯ ----------

/**
 * Корневые сборки: Assembly, которые НЕ являются child в bom_items.
 */
app.get('/api/products/root', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT p.*
      FROM products p
      WHERE p.type = 'Assembly'
        AND NOT EXISTS (
          SELECT 1 FROM bom_items b WHERE b.child_product_id = p.id
        )
      ORDER BY p.id;
    `);
    res.json(result.rows);
  } catch (e) {
    console.error('GET /api/products/root error:', e);
    res.status(500).json({ error: 'Internal error' });
  }
});

// карточка изделия
app.get('/api/products/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'Invalid id' });
  }
  try {
    const result = await db.query('SELECT * FROM products WHERE id = $1', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }
    res.json(result.rows[0]);
  } catch (e) {
    console.error('GET /api/products/:id error:', e);
    res.status(500).json({ error: 'Internal error' });
  }
});

// редактирование изделия (админ)
app.patch('/api/products/:id', requireAdmin, async (req, res) => {
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

    const pushField = (col, val) => {
      fields.push(`${col} = $${idx}`);
      values.push(val);
      idx++;
    };

    if (code !== undefined) pushField('code', String(code).trim());
    if (name !== undefined) pushField('name', String(name).trim());
    if (type !== undefined) {
      const allowed = ['Assembly', 'Part', 'Standard'];
      if (!allowed.includes(type)) {
        return res.status(400).json({ error: 'Invalid type' });
      }
      pushField('type', type);
    }

    if (mass_kg  !== undefined) pushField('mass_kg',  numOrNull(mass_kg));
    if (length_mm !== undefined) pushField('length_mm', numOrNull(length_mm));
    if (width_mm  !== undefined) pushField('width_mm',  numOrNull(width_mm));
    if (height_mm !== undefined) pushField('height_mm', numOrNull(height_mm));

    if (fields.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    values.push(id);
    const result = await db.query(
      `UPDATE products
       SET ${fields.join(', ')}
       WHERE id = $${idx}
       RETURNING *`,
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

// удаление изделия (админ)
app.delete('/api/products/:id', requireAdmin, async (req, res) => {
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
    const result = await db.query(
      'DELETE FROM products WHERE id = $1 RETURNING *',
      [id]
    );
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

// ---------- КАТАЛОГ: СОСТАВ (BOM) ----------

// дети сборки
app.get('/api/products/:id/children', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'Invalid id' });
  }
  try {
    const result = await db.query(
      `
      SELECT
        b.id       AS bom_item_id,
        b.quantity AS quantity,
        c.id       AS product_id,
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

// обновить количество в BOM (админ)
app.patch('/api/bom-items/:id', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'Invalid BOM item id' });
  }
  const qty = Number(req.body.quantity);
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

// удалить строку из BOM (админ)
app.delete('/api/bom-items/:id', requireAdmin, async (req, res) => {
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

// ---------- СОЗДАНИЕ НОВОГО УЗЛА (админ) ----------

app.post('/api/nodes', requireAdmin, async (req, res) => {
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

    const allowed = ['Assembly', 'Part', 'Standard'];
    if (!allowed.includes(type)) {
      return res.status(400).json({ error: 'type должен быть Assembly | Part | Standard' });
    }

    const parentIdNum = parentId ? Number(parentId) : null;

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

// ---------- МЕДИА: СПИСОК, ЗАГРУЗКА, УДАЛЕНИЕ ----------

// список медиа файла для изделия
app.get('/api/products/:id/media', async (req, res) => {
  const productId = Number(req.params.id);
  if (!Number.isInteger(productId)) {
    return res.status(400).json({ error: 'Invalid product id' });
  }
  try {
    const rows = await db.query(
      'SELECT * FROM media_files WHERE product_id = $1 ORDER BY id',
      [productId]
    );
    const data = rows.rows.map(r => ({
      id: r.id,
      kind: r.kind,
      url: (r.kind === 'model' ? '/media/models/' : '/media/images/') + r.filename,
      size_bytes: Number(r.size_bytes),
      mime_type: r.mime_type
    }));
    res.json(data);
  } catch (e) {
    console.error('GET /api/products/:id/media error:', e);
    res.status(500).json({ error: 'Internal error' });
  }
});

// загрузка файла (админ)
// kind = image | model
app.post(
  '/api/products/:id/upload/:kind',
  requireAdmin,
  upload.single('file'),
  async (req, res) => {
    const productId = Number(req.params.id);
    const kind = req.params.kind === 'model' ? 'model' : 'image';
    const file = req.file;

    if (!Number.isInteger(productId)) {
      if (file && fs.existsSync(file.path)) fs.unlinkSync(file.path);
      return res.status(400).json({ error: 'Invalid product id' });
    }
    if (!file) {
      return res.status(400).json({ error: 'No file' });
    }

    try {
      // проверка лимита хранилища
      const used = await getUsedBytes();
      const max = getMaxBytes();
      const newSize = used + file.size;
      if (newSize > max) {
        fs.unlinkSync(file.path);
        return res.status(413).json({
          error: 'Storage limit exceeded',
          used,
          max
        });
      }

      const prod = await db.query('SELECT id FROM products WHERE id = $1', [productId]);
      if (prod.rows.length === 0) {
        fs.unlinkSync(file.path);
        return res.status(404).json({ error: 'Product not found' });
      }

      const recIns = await db.query(
        `INSERT INTO media_files (product_id, kind, filename, mime_type, size_bytes)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [productId, kind, file.filename, file.mimetype, file.size]
      );
      const rec = recIns.rows[0];
      const urlBase = kind === 'model' ? '/media/models/' : '/media/images/';

      res.status(201).json({
        id: rec.id,
        kind: rec.kind,
        url: urlBase + rec.filename,
        size_bytes: Number(rec.size_bytes),
        mime_type: rec.mime_type
      });
    } catch (e) {
      console.error('upload error:', e);
      if (file && fs.existsSync(file.path)) fs.unlinkSync(file.path);
      res.status(500).json({ error: 'Internal error' });
    }
  }
);

// удаление медиа (админ)
app.delete('/api/media/:id', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'Invalid media id' });
  }
  try {
    const rows = await db.query('SELECT * FROM media_files WHERE id = $1', [id]);
    if (rows.rows.length === 0) {
      return res.status(404).json({ error: 'Not found' });
    }
    const rec = rows.rows[0];
    const dir = rec.kind === 'model' ? MODEL_DIR : IMAGE_DIR;
    const filePath = path.join(dir, rec.filename);

    await db.query('DELETE FROM media_files WHERE id = $1', [id]);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

    res.status(204).end();
  } catch (e) {
    console.error('DELETE /api/media/:id error:', e);
    res.status(500).json({ error: 'Internal error' });
  }
});

// ---------- КОРЗИНА ----------

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

// корзину оставляем публичной
app.post('/api/cart', async (req, res) => {
  try {
    const { productId, quantity } = req.body || {};
    const prodId = Number(productId);
    const qty = quantity ? Number(quantity) : 1;

    if (!Number.isInteger(prodId) || !(qty > 0)) {
      return res.status(400).json({ error: 'Invalid productId or quantity' });
    }

    const prodRes = await db.query('SELECT id FROM products WHERE id = $1', [prodId]);
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

// ---------- ЗАПУСК ----------

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
