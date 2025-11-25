// index.js — сервер каталога для Render (интернет-версия)

const path = require("path");
const fs = require("fs");
const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const multer = require("multer");

// ---------------------- Конфигурация ----------------------

const PORT = process.env.PORT || 10000;

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("ERROR: env.DATABASE_URL не задан");
  process.exit(1);
}

const ADMIN_USER = process.env.ADMIN_USER || "dro.ksv73@gmail.com";
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH || "";
const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-me";
const MAX_STORAGE_MB = Number(process.env.MAX_STORAGE_MB || 600);

// каталог для файлов (2D-картинки, 3D-модели)
const UPLOAD_DIR = path.join(__dirname, "uploads");
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// ---------------------- База данных -----------------------

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // Render Postgres
});

// вспомогательная функция
async function query(sql, params = []) {
  const client = await pool.connect();
  try {
    const res = await client.query(sql, params);
    return res.rows;
  } finally {
    client.release();
  }
}

// ---------------------- Express app -----------------------

const app = express();
app.use(cors());
app.use(express.json());

// статика для загруженных файлов (если потребуется)
app.use("/media", express.static(UPLOAD_DIR));

// ---------------------- Авторизация админа ----------------

function signAdminToken(email) {
  return jwt.sign({ email, role: "admin" }, JWT_SECRET, {
    expiresIn: "8h",
  });
}

function requireAdmin(req, res, next) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ")
    ? authHeader.slice("Bearer ".length)
    : null;

  if (!token) {
    return res.status(401).json({ error: "Требуется авторизация администратора" });
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.role !== "admin" || payload.email !== ADMIN_USER) {
      return res.status(403).json({ error: "Нет прав администратора" });
    }
    req.admin = payload;
    next();
  } catch (err) {
    console.error("JWT error:", err.message);
    return res.status(401).json({ error: "Сессия администратора недействительна" });
  }
}

// POST /api/admin/login  { email, password }
app.post("/api/admin/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};

    if (!email || !password) {
      return res
        .status(400)
        .json({ error: "Нужно передать email и пароль администратора" });
    }

    if (email !== ADMIN_USER) {
      return res.status(401).json({ error: "Неверный email или пароль" });
    }

    if (!ADMIN_PASSWORD_HASH) {
      return res
        .status(500)
        .json({ error: "ADMIN_PASSWORD_HASH не настроен на сервере" });
    }

    const ok = await bcrypt.compare(password, ADMIN_PASSWORD_HASH);
    if (!ok) {
      return res.status(401).json({ error: "Неверный email или пароль" });
    }

    const token = signAdminToken(email);
    res.json({ token });
  } catch (err) {
    console.error("admin login error:", err);
    res.status(500).json({ error: "Ошибка входа администратора" });
  }
});

// ---------------------- API каталога ----------------------
//
// Схема БД предполагается такой:
//
// products
//   id serial PK
//   code text
//   name text
//   type text  -- 'Assembly' | 'Part' | 'Standard'
//   mass_kg numeric
//   length_mm numeric
//   width_mm numeric
//   height_mm numeric
//
// bom_items
//   id serial PK
//   parent_id int REFERENCES products(id)
//   child_id int REFERENCES products(id)
//   quantity numeric
//
// cart_items
//   id serial PK
//   product_id int REFERENCES products(id)
//   quantity numeric
//
// Если у тебя другая схема — подкорректируй SQL под неё.

// ---- чтение изделий ----

// все изделия (корень дерева)
app.get("/api/products/root", async (req, res) => {
  try {
    const rows = await query(
      `SELECT id, code, name, type,
              mass_kg, length_mm, width_mm, height_mm
       FROM products
       ORDER BY code`
    );
    res.json(rows);
  } catch (err) {
    console.error("Failed to load root products:", err);
    res.status(500).json({ error: "Failed to load root products" });
  }
});

// данные одного изделия
app.get("/api/products/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const rows = await query(
      `SELECT id, code, name, type,
              mass_kg, length_mm, width_mm, height_mm
       FROM products
       WHERE id = $1`,
      [id]
    );
    if (!rows.length) {
      return res.status(404).json({ error: "Изделие не найдено" });
    }
    res.json(rows[0]);
  } catch (err) {
    console.error("Failed to load product:", err);
    res.status(500).json({ error: "Ошибка загрузки изделия" });
  }
});

// состав изделия (дети)
app.get("/api/products/:id/children", async (req, res) => {
  try {
    const parentId = Number(req.params.id);
    const rows = await query(
      `SELECT
          b.id AS bom_item_id,
          b.quantity,
          p.id AS product_id,
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
       ORDER BY p.code`,
      [parentId]
    );
    res.json(rows);
  } catch (err) {
    console.error("Failed to load children:", err);
    res.status(500).json({ error: "Ошибка загрузки состава" });
  }
});

// ---- управление изделиями (только админ) ----

// создать изделие
app.post("/api/products", requireAdmin, async (req, res) => {
  try {
    const {
      code,
      name,
      type,
      mass_kg = null,
      length_mm = null,
      width_mm = null,
      height_mm = null,
    } = req.body || {};

    const rows = await query(
      `INSERT INTO products
         (code, name, type, mass_kg, length_mm, width_mm, height_mm)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING id, code, name, type,
                 mass_kg, length_mm, width_mm, height_mm`,
      [code, name, type, mass_kg, length_mm, width_mm, height_mm]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error("Failed to create product:", err);
    res.status(500).json({ error: "Ошибка создания изделия" });
  }
});

// обновить изделие
app.put("/api/products/:id", requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const {
      code,
      name,
      type,
      mass_kg = null,
      length_mm = null,
      width_mm = null,
      height_mm = null,
    } = req.body || {};

    const rows = await query(
      `UPDATE products SET
          code = $1,
          name = $2,
          type = $3,
          mass_kg = $4,
          length_mm = $5,
          width_mm = $6,
          height_mm = $7
       WHERE id = $8
       RETURNING id, code, name, type,
                 mass_kg, length_mm, width_mm, height_mm`,
      [code, name, type, mass_kg, length_mm, width_mm, height_mm, id]
    );

    if (!rows.length) {
      return res.status(404).json({ error: "Изделие не найдено" });
    }
    res.json(rows[0]);
  } catch (err) {
    console.error("Failed to update product:", err);
    res.status(500).json({ error: "Ошибка обновления изделия" });
  }
});

// удалить изделие (со связями)
app.delete("/api/products/:id", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  try {
    await query(`DELETE FROM bom_items WHERE parent_id = $1 OR child_id = $1`, [id]);
    await query(`DELETE FROM cart_items WHERE product_id = $1`, [id]);
    const rows = await query(`DELETE FROM products WHERE id = $1 RETURNING id`, [id]);

    if (!rows.length) {
      return res.status(404).json({ error: "Изделие не найдено" });
    }
    res.json({ success: true });
  } catch (err) {
    console.error("Failed to delete product:", err);
    res.status(500).json({ error: "Ошибка удаления изделия" });
  }
});

// ---- управление составом (BOM) (только админ) ----

// добавить позицию в состав
app.post("/api/products/:parentId/children", requireAdmin, async (req, res) => {
  try {
    const parentId = Number(req.params.parentId);
    const { childId, quantity } = req.body || {};

    const rows = await query(
      `INSERT INTO bom_items (parent_id, child_id, quantity)
       VALUES ($1,$2,$3)
       RETURNING id AS bom_item_id, parent_id, child_id, quantity`,
      [parentId, childId, quantity]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error("Failed to add bom item:", err);
    res.status(500).json({ error: "Ошибка добавления позиции в состав" });
  }
});

// изменить количество в составе
app.put(
  "/api/products/:parentId/children/:bomItemId",
  requireAdmin,
  async (req, res) => {
    try {
      const bomItemId = Number(req.params.bomItemId);
      const { quantity } = req.body || {};

      const rows = await query(
        `UPDATE bom_items
           SET quantity = $1
         WHERE id = $2
         RETURNING id AS bom_item_id, parent_id, child_id, quantity`,
        [quantity, bomItemId]
      );
      if (!rows.length) {
        return res.status(404).json({ error: "Позиция состава не найдена" });
      }
      res.json(rows[0]);
    } catch (err) {
      console.error("Failed to update bom item:", err);
      res.status(500).json({ error: "Ошибка изменения позиции состава" });
    }
  }
);

// удалить позицию из состава
app.delete(
  "/api/products/:parentId/children/:bomItemId",
  requireAdmin,
  async (req, res) => {
    try {
      const bomItemId = Number(req.params.bomItemId);
      const rows = await query(
        `DELETE FROM bom_items WHERE id = $1 RETURNING id`,
        [bomItemId]
      );
      if (!rows.length) {
        return res.status(404).json({ error: "Позиция состава не найдена" });
      }
      res.json({ success: true });
    } catch (err) {
      console.error("Failed to delete bom item:", err);
      res.status(500).json({ error: "Ошибка удаления позиции состава" });
    }
  }
);

// ---------------------- Корзина ---------------------------

// получить корзину
app.get("/api/cart", async (req, res) => {
  try {
    const rows = await query(
      `SELECT c.id,
              c.product_id,
              c.quantity,
              p.code,
              p.name,
              p.type
       FROM cart_items c
       JOIN products p ON p.id = c.product_id
       ORDER BY c.id`
    );
    res.json(rows);
  } catch (err) {
    console.error("Failed to load cart:", err);
    res.status(500).json({ error: "Ошибка загрузки корзины" });
  }
});

// добавить в корзину
app.post("/api/cart", async (req, res) => {
  try {
    const { productId, quantity = 1 } = req.body || {};
    const rows = await query(
      `INSERT INTO cart_items (product_id, quantity)
       VALUES ($1,$2)
       RETURNING id, product_id, quantity`,
      [productId, quantity]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error("Failed to add to cart:", err);
    res.status(500).json({ error: "Ошибка добавления в корзину" });
  }
});

// удалить позицию корзины
app.delete("/api/cart/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const rows = await query(
      `DELETE FROM cart_items WHERE id = $1 RETURNING id`,
      [id]
    );
    if (!rows.length) {
      return res.status(404).json({ error: "Позиция корзины не найдена" });
    }
    res.json({ success: true });
  } catch (err) {
    console.error("Failed to delete from cart:", err);
    res.status(500).json({ error: "Ошибка удаления из корзины" });
  }
});

// очистить корзину
app.delete("/api/cart", async (req, res) => {
  try {
    await query(`DELETE FROM cart_items`);
    res.json({ success: true });
  } catch (err) {
    console.error("Failed to clear cart:", err);
    res.status(500).json({ error: "Ошибка очистки корзины" });
  }
});

// ---------------------- Загрузка файлов -------------------

// хранилище (2D/3D) — простой вариант, без привязки к изделиям.
// позже можно расширить, если понадобится.

const upload = multer({ dest: UPLOAD_DIR });

// загрузка файла (только админ)
app.post("/api/files/upload", requireAdmin, upload.single("file"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "Файл не получен" });
  }
  res.json({
    filename: req.file.filename,
    originalName: req.file.originalname,
    size: req.file.size,
    url: `/media/${req.file.filename}`,
  });
});

// статистика по хранилищу (только админ)
function getDirSizeBytes(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isFile()) {
      total += fs.statSync(full).size;
    } else if (entry.isDirectory()) {
      total += getDirSizeBytes(full);
    }
  }
  return total;
}

app.get("/api/storage/stats", requireAdmin, (req, res) => {
  try {
    const usedBytes = fs.existsSync(UPLOAD_DIR) ? getDirSizeBytes(UPLOAD_DIR) : 0;
    const usedMB = usedBytes / (1024 * 1024);
    const freeMB = Math.max(0, MAX_STORAGE_MB - usedMB);

    let fileCount = 0;
    if (fs.existsSync(UPLOAD_DIR)) {
      fileCount = fs.readdirSync(UPLOAD_DIR).length;
    }

    res.json({
      maxMB: MAX_STORAGE_MB,
      usedMB: Number(usedMB.toFixed(2)),
      freeMB: Number(freeMB.toFixed(2)),
      fileCount,
    });
  } catch (err) {
    console.error("storage stats error:", err);
    res.status(500).json({ error: "Ошибка получения статистики хранилища" });
  }
});

// ---------------------- Health & start --------------------

app.get("/", (req, res) => {
  res.send("KC-8165 catalog API is running");
});

app.listen(PORT, () => {
  console.log(`Catalog API is listening on port ${PORT}`);
});
