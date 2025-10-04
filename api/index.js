// api/[...route].js
import express from "express";
import cors from "cors";
import serverless from "serverless-http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";
// Si tu préfères, tu peux utiliser le fetch global de Node 18+/Vercel 22.x et
// supprimer la dépendance undici. Ici on garde undici pour compat.
import { fetch } from "undici";

// ---------- Paths ----------
const __dirname = path.dirname(fileURLToPath(import.meta.url));
// db.json à côté du handler (recommandé)
const DB_PATH_API = path.join(__dirname, "db.json");
// fallback si le fichier est à la racine du projet
const DB_PATH_ROOT = path.join(process.cwd(), "db.json");

// ---------- Config ----------
const app = express();
app.use(cors({ origin: "*", methods: "GET,POST,PATCH,PUT,DELETE,OPTIONS" }));
app.use(express.json());

// Optionnel : URL distante pour charger le JSON (ex: jsDelivr / GitHub Raw)
const DATA_URL = process.env.DATA_URL;

// ---------- Mémoire ----------
let db = {};

function ensureArrays(d) {
  for (const k of Object.keys(d)) {
    if (!Array.isArray(d[k])) d[k] = [];
  }
}

function tryLoadFrom(p) {
  if (!fs.existsSync(p)) return false;
  const text = fs.readFileSync(p, "utf-8");
  db = JSON.parse(text);
  ensureArrays(db);
  console.log("[API] DB chargée depuis", p);
  return true;
}

function loadLocalDB() {
  if (tryLoadFrom(DB_PATH_API)) return;
  if (tryLoadFrom(DB_PATH_ROOT)) return;
  throw new Error("db.json introuvable ni dans api/ ni à la racine");
}

async function loadRemoteDB(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`DATA_URL fetch error: ${res.status}`);
  db = await res.json();
  ensureArrays(db);
  console.log("[API] DB chargée depuis DATA_URL");
}

// ---------- Cold start : charger la DB et BLOQUER les requêtes tant que ce n’est pas prêt ----------
const readyPromise = (async () => {
  try {
    if (DATA_URL) await loadRemoteDB(DATA_URL);
    else loadLocalDB();
  } catch (e) {
    console.error("[API] Chargement DB échoué:", e);
    // Dernier fallback local
    try { loadLocalDB(); } catch {}
  }
})();

// Middleware pour attendre le chargement de la DB
app.use(async (_req, _res, next) => {
  await readyPromise;
  next();
});

// ---------- Utils ----------
function toInt(v, def) {
  const n = parseInt(String(v), 10);
  return Number.isFinite(n) ? n : def;
}

function matches(item, query) {
  // filtrage simple par égalité (insensible à la casse pour string)
  for (const [k, v] of Object.entries(query)) {
    if (["_page", "_limit", "_sort", "_order", "q"].includes(k)) continue;
    const iv = item[k];
    if (typeof v === "string" && typeof iv === "string") {
      if (iv.toLowerCase() !== v.toLowerCase()) return false;
    } else if (iv != v) {
      return false;
    }
  }
  return true;
}

function fullText(item, needle) {
  const hay = JSON.stringify(item).toLowerCase();
  return hay.includes(String(needle).toLowerCase());
}

function sortItems(items, sortKey, order) {
  if (!sortKey) return items;
  const dir = (order || "asc").toLowerCase() === "desc" ? -1 : 1;
  return [...items].sort((a, b) => {
    const va = a?.[sortKey];
    const vb = b?.[sortKey];
    if (va === vb) return 0;
    return va > vb ? dir : -dir;
  });
}

// ---------- Routes ----------
app.get("/api", (_req, res) => {
  res.json({ resources: Object.keys(db) });
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, resources: Object.keys(db) });
});

app.get("/api/:resource", (req, res) => {
  const { resource } = req.params;
  const data = db[resource];
  if (!data) return res.status(404).json({ error: "Resource not found" });

  const { _page, _limit, _sort, _order, q, ...filters } = req.query;

  // filtre
  let items = data.filter((x) => matches(x, filters));

  // recherche plein texte (facultative)
  if (q) items = items.filter((x) => fullText(x, q));

  // tri
  items = sortItems(items, _sort, _order);

  // pagination
  const page = Math.max(1, toInt(_page, 1));
  const limit = Math.max(1, Math.min(1000, toInt(_limit, items.length)));
  const start = (page - 1) * limit;
  const end = start + limit;

  res.setHeader("X-Total-Count", String(items.length));
  res.json(items.slice(start, end));
});

app.get("/api/:resource/:id", (req, res) => {
  const { resource, id } = req.params;
  const data = db[resource];
  if (!data) return res.status(404).json({ error: "Resource not found" });

  const found = data.find((x) => String(x.id) === String(id));
  if (!found) return res.status(404).json({ error: "Not found" });
  res.json(found);
});

app.post("/api/:resource", (req, res) => {
  const { resource } = req.params;
  const data = db[resource];
  if (!data) return res.status(404).json({ error: "Resource not found" });

  const body = req.body ?? {};
  if (!("id" in body)) body.id = randomUUID();
  data.push(body);
  res.status(201).json(body);
});

app.patch("/api/:resource/:id", (req, res) => {
  const { resource, id } = req.params;
  const data = db[resource];
  if (!data) return res.status(404).json({ error: "Resource not found" });

  const idx = data.findIndex((x) => String(x.id) === String(id));
  if (idx < 0) return res.status(404).json({ error: "Not found" });

  data[idx] = { ...data[idx], ...req.body, id: data[idx].id };
  res.json(data[idx]);
});

app.put("/api/:resource/:id", (req, res) => {
  const { resource, id } = req.params;
  const data = db[resource];
  if (!data) return res.status(404).json({ error: "Resource not found" });

  const idx = data.findIndex((x) => String(x.id) === String(id));
  if (idx < 0) return res.status(404).json({ error: "Not found" });

  const next = { ...req.body, id: data[idx].id };
  data[idx] = next;
  res.json(next);
});

app.delete("/api/:resource/:id", (req, res) => {
  const { resource, id } = req.params;
  const data = db[resource];
  if (!data) return res.status(404).json({ error: "Resource not found" });

  const idx = data.findIndex((x) => String(x.id) === String(id));
  if (idx < 0) return res.status(404).json({ error: "Not found" });

  const [removed] = data.splice(idx, 1);
  res.json(removed);
});

export default serverless(app);

