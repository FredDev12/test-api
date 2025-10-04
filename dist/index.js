import express from "express";
import cors from "cors";
import serverless from "serverless-http";
import fs from "fs";
import { randomUUID } from "crypto";
import { fetch } from "undici";
// ---------- Config ----------
const app = express();
app.use(cors({ origin: "*", methods: "GET,POST,PATCH,PUT,DELETE,OPTIONS" }));
app.use(express.json());
// Optionnel : URL distante pour charger le JSON (ex: jsDelivr / GitHub Raw)
const DATA_URL = process.env.DATA_URL; // si défini, on fetch au cold start
// ---------- Mémoire ----------
let db = {};
function loadLocalDB() {
    const text = fs.readFileSync(process.cwd() + "/db.json", "utf-8");
    db = JSON.parse(text);
    ensureArrays(db);
    console.log("[API] DB chargée depuis db.json (local)");
}
async function loadRemoteDB(url) {
    const res = await fetch(url);
    if (!res.ok)
        throw new Error(`DATA_URL fetch error: ${res.status}`);
    db = (await res.json());
    ensureArrays(db);
    console.log("[API] DB chargée depuis DATA_URL");
}
function ensureArrays(d) {
    for (const k of Object.keys(d)) {
        if (!Array.isArray(d[k]))
            d[k] = [];
    }
}
// Cold start: charge DB
(async () => {
    try {
        if (DATA_URL)
            await loadRemoteDB(DATA_URL);
        else
            loadLocalDB();
    }
    catch (e) {
        console.error("[API] Chargement DB échoué:", e);
        // fallback local
        try {
            loadLocalDB();
        }
        catch { }
    }
})();
// ---------- Utils ----------
function toInt(v, def) {
    const n = parseInt(String(v), 10);
    return Number.isFinite(n) ? n : def;
}
function matches(item, query) {
    // filtrage simple par égalité ou sous-chaîne si valeur string
    for (const [k, v] of Object.entries(query)) {
        if (["_page", "_limit", "_sort", "_order", "q"].includes(k))
            continue;
        const iv = item[k];
        if (typeof v === "string" && typeof iv === "string") {
            if (iv.toLowerCase() !== v.toLowerCase())
                return false;
        }
        else if (iv != v) {
            return false;
        }
    }
    return true;
}
function fullText(item, needle) {
    const hay = JSON.stringify(item).toLowerCase();
    return hay.includes(needle.toLowerCase());
}
function sortItems(items, sortKey, order) {
    if (!sortKey)
        return items;
    const dir = (order || "asc").toLowerCase() === "desc" ? -1 : 1;
    return [...items].sort((a, b) => {
        const va = a?.[sortKey];
        const vb = b?.[sortKey];
        if (va === vb)
            return 0;
        return va > vb ? dir : -dir;
    });
}
// ---------- Routes ----------
app.get("/api", (_req, res) => {
    res.json({ resources: Object.keys(db) });
});
app.get("/api/:resource", (req, res) => {
    const { resource } = req.params;
    const data = db[resource];
    if (!data)
        return res.status(404).json({ error: "Resource not found" });
    const { _page, _limit, _sort, _order, q, ...filters } = req.query;
    // filtre
    let items = data.filter((x) => matches(x, filters));
    // recherche plein texte (facultative)
    if (q)
        items = items.filter((x) => fullText(x, q));
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
    if (!data)
        return res.status(404).json({ error: "Resource not found" });
    const found = data.find((x) => String(x.id) === String(id));
    if (!found)
        return res.status(404).json({ error: "Not found" });
    res.json(found);
});
app.post("/api/:resource", (req, res) => {
    const { resource } = req.params;
    const data = db[resource];
    if (!data)
        return res.status(404).json({ error: "Resource not found" });
    const body = req.body ?? {};
    if (!("id" in body))
        body.id = randomUUID();
    data.push(body);
    res.status(201).json(body);
});
app.patch("/api/:resource/:id", (req, res) => {
    const { resource, id } = req.params;
    const data = db[resource];
    if (!data)
        return res.status(404).json({ error: "Resource not found" });
    const idx = data.findIndex((x) => String(x.id) === String(id));
    if (idx < 0)
        return res.status(404).json({ error: "Not found" });
    data[idx] = { ...data[idx], ...req.body, id: data[idx].id };
    res.json(data[idx]);
});
app.put("/api/:resource/:id", (req, res) => {
    const { resource, id } = req.params;
    const data = db[resource];
    if (!data)
        return res.status(404).json({ error: "Resource not found" });
    const idx = data.findIndex((x) => String(x.id) === String(id));
    if (idx < 0)
        return res.status(404).json({ error: "Not found" });
    const next = { ...req.body, id: data[idx].id };
    data[idx] = next;
    res.json(next);
});
app.delete("/api/:resource/:id", (req, res) => {
    const { resource, id } = req.params;
    const data = db[resource];
    if (!data)
        return res.status(404).json({ error: "Resource not found" });
    const idx = data.findIndex((x) => String(x.id) === String(id));
    if (idx < 0)
        return res.status(404).json({ error: "Not found" });
    const [removed] = data.splice(idx, 1);
    res.json(removed);
});
// Healthcheck
app.get("/api/health", (_req, res) => res.json({ ok: true, resources: Object.keys(db) }));
export default serverless(app);
