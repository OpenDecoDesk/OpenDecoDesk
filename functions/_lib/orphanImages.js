// Tools → Orphaned images (2026-10): files in the public image store (the IMAGES R2 bucket) that nothing in the
// database points to any more — a photo replaced or removed from a product / blank / org / graphic, a duplicate
// taken off a blank, an upload whose form was never saved, a design-verification image whose record is gone.
// "Points to" is checked generically: every text column of every table is searched for the file's key, so a new
// table that stores image addresses is covered without a change here (order lines' snapshots count — an order still
// shows its picture). A "-thumb" copy belongs to its main image. Files uploaded in the last 24 hours are never
// called orphaned (a form may still be open with them). Deleting re-checks every key on the server first.
const GRACE_MS = 24 * 60 * 60 * 1000;

// All the text the database holds that could carry an image address, as one string (keys are matched inside it).
async function referenceText_(db) {
  const { results: tables } = await db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'd1_%' AND name NOT LIKE '_cf_%'").all();
  const parts = [];
  for (const t of tables || []) {
    const name = String(t.name);
    if (!/^[A-Za-z0-9_]+$/.test(name)) continue;
    const { results: cols } = await db.prepare(`SELECT name, type FROM pragma_table_info('${name}')`).all();
    const textCols = (cols || []).filter(c => !c.type || /TEXT|CHAR|CLOB|JSON/i.test(String(c.type))).map(c => String(c.name)).filter(c => /^[A-Za-z0-9_]+$/.test(c));
    for (const c of textCols) {
      const { results } = await db.prepare(`SELECT "${c}" AS v FROM "${name}" WHERE "${c}" LIKE '%uploads/%' OR "${c}" LIKE '%verify/%' OR "${c}" LIKE '%images.%'`).all();
      for (const r of results || []) if (r.v) parts.push(String(r.v));
    }
  }
  return parts.join("\n");
}

const mainKeyOf_ = (key) => String(key).replace(/-thumb(\.[A-Za-z0-9]+)$/, "$1");
const publicBase_ = (env) => { const raw = String(env.R2_PUBLIC_BASE || "").replace(/\/+$/, ""); return raw && !/^https?:\/\//i.test(raw) ? "https://" + raw : raw; };

// Lists every object in the bucket and returns the unreferenced ones: {orphans: [{key, url, size, uploaded, thumbOf}],
// scanned, recent, totalBytes}. thumbOf = the main key when this is a "-thumb" copy.
export async function findOrphanImages(env, db, { now = Date.now() } = {}) {
  if (!env.IMAGES) throw Object.assign(new Error("Image storage isn't set up on this site."), { userFacing: true });
  const text = await referenceText_(db);
  const base = publicBase_(env);
  const orphans = [];
  let scanned = 0, recent = 0, cursor;
  do {
    const page = await env.IMAGES.list({ cursor, limit: 1000 });
    for (const o of page.objects || []) {
      scanned++;
      const uploaded = o.uploaded ? new Date(o.uploaded).getTime() : 0;
      if (uploaded && now - uploaded < GRACE_MS) { recent++; continue; }
      const main = mainKeyOf_(o.key);
      if (text.includes(main)) continue;
      orphans.push({ key: o.key, url: base ? base + "/" + o.key : "", size: Number(o.size) || 0, uploaded: o.uploaded ? new Date(o.uploaded).toISOString() : "", thumbOf: main !== o.key ? main : "" });
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  orphans.sort((a, b) => String(a.key).localeCompare(String(b.key)));
  return { orphans, scanned, recent, totalBytes: orphans.reduce((s, o) => s + o.size, 0) };
}

// Deletes the given keys — each only if it is STILL unreferenced and older than the grace period (re-checked here,
// so a stale list can't delete an image that's back in use). Returns {deleted: [keys], kept: [{key, why}]}.
export async function deleteOrphanImages(env, db, keys, { now = Date.now() } = {}) {
  if (!env.IMAGES) throw Object.assign(new Error("Image storage isn't set up on this site."), { userFacing: true });
  const want = [...new Set((Array.isArray(keys) ? keys : []).map(String))].filter(k => k && !k.includes("..") && !k.startsWith("/")).slice(0, 1000);
  const text = await referenceText_(db);
  const deleted = [], kept = [];
  for (const key of want) {
    if (text.includes(mainKeyOf_(key))) { kept.push({ key, why: "in use again" }); continue; }
    const head = await env.IMAGES.head(key).catch(() => null);
    if (!head) { kept.push({ key, why: "already gone" }); continue; }
    const uploaded = head.uploaded ? new Date(head.uploaded).getTime() : 0;
    if (uploaded && now - uploaded < GRACE_MS) { kept.push({ key, why: "uploaded in the last 24 hours" }); continue; }
    await env.IMAGES.delete(key);
    deleted.push(key);
  }
  return { deleted, kept };
}
