// The desktop program's file storage: pictures, receipts and design files as ordinary files in the
// data folder, instead of in Miniflare's own storage format. The Worker still uses them as R2 buckets
// (env.IMAGES.put / get / head / delete / list — see desktop/r2-files-binding.mjs, which turns those
// calls into requests answered by `handle` below), so none of its code changes.
//
//   state/files/images/uploads/shop/3f9a….png        the file itself, as it was uploaded
//   state/files/.meta/images/uploads/shop/3f9a….png.json   its content type, name, upload time
//
// They live under state/ so a backup (File → Back up…) and a restore carry them with the database.
// Plain CommonJS with no dependencies, so the program and the tests can both load it.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const BUCKETS = ["images", "receipts", "designs"];
const MAX_KEY = 1024;
// Names Windows won't create a file under, whatever the extension.
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

// A key ("uploads/shop/abc.png") → the parts of a path, or null when it isn't a safe key: empty, too
// long, absolute, with an empty, "." or ".." part, or a backslash or NUL. Every character outside
// [A-Za-z0-9._-] in a part is written as %XX, and a part Windows reserves gets a leading "%", so any
// key the Worker uses becomes a valid file name on Windows, macOS and Linux (today's keys are made of
// letters, digits, dashes and dots and come out unchanged).
function keyParts(key) {
  const k = String(key == null ? "" : key);
  if (!k || k.length > MAX_KEY || k.startsWith("/") || /[\\\0]/.test(k)) return null;
  const parts = k.split("/");
  if (parts.some(p => !p || p === "." || p === "..")) return null;
  return parts.map(p => {
    const enc = p.replace(/[^A-Za-z0-9._-]/g, (c) => Buffer.from(c, "utf8").toString("hex").replace(/../g, "%$&").toUpperCase());
    return WINDOWS_RESERVED.test(enc) ? "%" + enc : enc;
  });
}
function partToKey_(p) {
  const s = p.startsWith("%") && WINDOWS_RESERVED.test(p.slice(1)) ? p.slice(1) : p;
  return decodeURIComponent(s);
}

class FileStore {
  constructor(root) { this.root = root; }

  dir_(bucket) {
    if (!BUCKETS.includes(bucket)) throw Object.assign(new Error("No such bucket"), { status: 404 });
    return path.join(this.root, bucket);
  }
  paths_(bucket, key) {
    const parts = keyParts(key);
    if (!parts) throw Object.assign(new Error("Bad key"), { status: 400 });
    return { file: path.join(this.dir_(bucket), ...parts), meta: path.join(this.root, ".meta", bucket, ...parts) + ".json" };
  }
  // Written to a temporary name beside it and renamed into place, so a crash never leaves half a file.
  writeAtomic_(file, data) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + ".tmp-" + crypto.randomBytes(6).toString("hex");
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, file);
  }

  put(bucket, key, bytes, { httpMetadata = {}, customMetadata = {}, uploaded } = {}) {
    const p = this.paths_(bucket, key);
    const body = Buffer.from(bytes);
    const meta = { key: String(key), size: body.length, uploaded: uploaded || new Date().toISOString(),
      httpMetadata: clean_(httpMetadata), customMetadata: clean_(customMetadata) };
    this.writeAtomic_(p.file, body);
    this.writeAtomic_(p.meta, JSON.stringify(meta));
    return meta;
  }
  head(bucket, key) {
    const p = this.paths_(bucket, key);
    let st;
    try { st = fs.statSync(p.file); } catch (e) { return null; }
    if (!st.isFile()) return null;
    let meta = {};
    try { meta = JSON.parse(fs.readFileSync(p.meta, "utf8")); } catch (e) { /* a file put here by hand: no details */ }
    return { key: String(key), size: st.size, uploaded: meta.uploaded || st.mtime.toISOString(),
      httpMetadata: meta.httpMetadata || {}, customMetadata: meta.customMetadata || {} };
  }
  get(bucket, key) {
    const h = this.head(bucket, key);
    if (!h) return null;
    return { ...h, body: fs.readFileSync(this.paths_(bucket, key).file) };
  }
  delete(bucket, key) {
    const p = this.paths_(bucket, key);
    for (const f of [p.file, p.meta]) { try { fs.unlinkSync(f); } catch (e) { /* already gone */ } }
  }
  // Keys in order, after `cursor` (the last key of the previous page), at most `limit` (1–1000) of them.
  list(bucket, { prefix = "", cursor = "", limit = 1000 } = {}) {
    const dir = this.dir_(bucket), keys = [];
    const walk = (d, parts) => {
      let entries;
      try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
      for (const e of entries) {
        if (e.name.includes(".tmp-")) continue;
        if (e.isDirectory()) walk(path.join(d, e.name), [...parts, e.name]);
        else if (e.isFile()) keys.push([...parts, e.name].map(partToKey_).join("/"));
      }
    };
    walk(dir, []);
    keys.sort();
    const n = Math.max(1, Math.min(1000, Number(limit) || 1000));
    const page = keys.filter(k => k.startsWith(String(prefix || "")) && (!cursor || k > cursor)).slice(0, n + 1);
    const truncated = page.length > n, objects = page.slice(0, n).map(k => this.head(bucket, k));
    return { objects, truncated, cursor: truncated ? objects[objects.length - 1].key : undefined };
  }

  // The requests desktop/r2-files-binding.mjs sends (a Miniflare service binding answered here in
  // Node): METHOD http://files/<bucket>?key=…  — PUT (body = the bytes, X-Meta = JSON of
  // httpMetadata / customMetadata), GET, HEAD, DELETE, and GET …/<bucket>?list=1&prefix&cursor&limit.
  async handle(request) {
    const url = new URL(request.url);
    const bucket = url.pathname.replace(/^\/+/, "");
    const key = url.searchParams.get("key") || "";
    const metaHeader = (m) => ({ "X-Meta": encodeURIComponent(JSON.stringify(m)) });
    try {
      if (request.method === "GET" && url.searchParams.get("list")) {
        const r = this.list(bucket, { prefix: url.searchParams.get("prefix") || "", cursor: url.searchParams.get("cursor") || "", limit: url.searchParams.get("limit") });
        return Response.json(r);
      }
      if (request.method === "PUT") {
        let meta = {};
        try { meta = JSON.parse(decodeURIComponent(request.headers.get("X-Meta") || "%7B%7D")); } catch (e) {}
        const m = this.put(bucket, key, new Uint8Array(await request.arrayBuffer()), meta);
        return new Response(null, { status: 200, headers: metaHeader(m) });
      }
      if (request.method === "HEAD" || request.method === "GET") {
        const o = request.method === "GET" ? this.get(bucket, key) : this.head(bucket, key);
        if (!o) return new Response(null, { status: 404 });
        const { body, ...m } = o;
        return new Response(request.method === "GET" ? body : null, { status: 200, headers: metaHeader(m) });
      }
      if (request.method === "DELETE") { this.delete(bucket, key); return new Response(null, { status: 204 }); }
      return new Response(null, { status: 405 });
    } catch (e) {
      return new Response(String((e && e.message) || e), { status: (e && e.status) || 500 });
    }
  }
}
// Metadata kept: plain string values only (what R2 keeps).
function clean_(o) {
  const out = {};
  for (const [k, v] of Object.entries(o && typeof o === "object" ? o : {})) if (v != null && typeof v !== "object") out[k] = String(v);
  return out;
}

// Copies everything from Miniflare's own R2 storage (the desktop program before plain files) into
// the store, keeping each file's details. `bucket(name)` is Miniflare's R2 bucket. Returns a count.
async function copyFromR2(store, bucketFor) {
  let copied = 0;
  for (const name of BUCKETS) {
    const r2 = await bucketFor(name.toUpperCase());
    let cursor;
    do {
      const page = await r2.list({ cursor, limit: 500, include: ["httpMetadata", "customMetadata"] });
      for (const o of page.objects || []) {
        if (!keyParts(o.key)) continue;
        const obj = await r2.get(o.key);
        if (!obj) continue;
        store.put(name, o.key, new Uint8Array(await obj.arrayBuffer()), { httpMetadata: obj.httpMetadata || {}, customMetadata: obj.customMetadata || {},
          uploaded: obj.uploaded ? new Date(obj.uploaded).toISOString() : undefined });
        copied++;
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  }
  return copied;
}

module.exports = { FileStore, keyParts, copyFromR2, BUCKETS };
