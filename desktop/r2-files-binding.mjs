// The desktop program's R2 buckets (IMAGES, RECEIPTS, DESIGNS) as the Worker sees them: the parts of
// the R2 API the code uses — put, get, head, delete, list — each turned into one request to the program
// (env.STORE, a Miniflare service binding answered by FileStore#handle in desktop/files.js), which keeps
// the files as ordinary files in the data folder. Wired by desktop/server.js as a Miniflare "wrapped
// binding": this module's default export is called with { STORE, BUCKET } and returns the bucket.

const decodeMeta = (res) => {
  try { return JSON.parse(decodeURIComponent(res.headers.get("X-Meta") || "%7B%7D")); } catch (e) { return {}; }
};
// An object as R2 describes it (R2Object), from the program's details.
function r2Object(m) {
  return {
    key: m.key, size: Number(m.size) || 0, uploaded: new Date(m.uploaded || Date.now()),
    httpMetadata: m.httpMetadata || {}, customMetadata: m.customMetadata || {},
    etag: "", httpEtag: "", version: "", checksums: {}, storageClass: "Standard",
    writeHttpMetadata(headers) {
      const h = this.httpMetadata;
      if (h.contentType) headers.set("Content-Type", h.contentType);
      if (h.contentDisposition) headers.set("Content-Disposition", h.contentDisposition);
      if (h.cacheControl) headers.set("Cache-Control", h.cacheControl);
      if (h.contentEncoding) headers.set("Content-Encoding", h.contentEncoding);
      if (h.contentLanguage) headers.set("Content-Language", h.contentLanguage);
    },
  };
}
const bytesOf = async (value) => {
  if (value == null) return new Uint8Array(0);
  if (typeof value === "string") return new TextEncoder().encode(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return new Uint8Array(await new Response(value).arrayBuffer());   // a stream or Blob
};

class FilesBucket {
  constructor(store, bucket) { this.store = store; this.bucket = bucket; }
  url_(params) { return "http://files/" + this.bucket + "?" + new URLSearchParams(params).toString(); }
  async fail_(res, what) { throw new Error("File storage " + what + " failed (" + res.status + "): " + (await res.text().catch(() => ""))); }

  async put(key, value, options = {}) {
    const meta = { httpMetadata: options.httpMetadata || {}, customMetadata: options.customMetadata || {} };
    const res = await this.store.fetch(this.url_({ key }), { method: "PUT", body: await bytesOf(value),
      headers: { "X-Meta": encodeURIComponent(JSON.stringify(meta)) } });
    if (!res.ok) await this.fail_(res, "put");
    return r2Object(decodeMeta(res));
  }
  async head(key) {
    const res = await this.store.fetch(this.url_({ key }), { method: "HEAD" });
    if (res.status === 404) return null;
    if (!res.ok) await this.fail_(res, "head");
    return r2Object(decodeMeta(res));
  }
  async get(key) {
    const res = await this.store.fetch(this.url_({ key }), { method: "GET" });
    if (res.status === 404) return null;
    if (!res.ok) await this.fail_(res, "get");
    const bytes = new Uint8Array(await res.arrayBuffer());
    const o = r2Object(decodeMeta(res));
    let used = false;
    const take = () => { if (used) throw new TypeError("The body has already been read."); used = true; return bytes; };
    // Defined, not assigned: Object.assign would call the body getter and use the body up.
    Object.defineProperties(o, {
      body: { get() { return new Response(take()).body; }, enumerable: true },
      bodyUsed: { get() { return used; }, enumerable: true },
    });
    o.arrayBuffer = async () => { const b = take(); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
    o.text = async () => new TextDecoder().decode(take());
    o.json = async () => JSON.parse(new TextDecoder().decode(take()));
    o.blob = async () => new Blob([take()], { type: o.httpMetadata.contentType || "" });
    return o;
  }
  async delete(keys) {
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      const res = await this.store.fetch(this.url_({ key }), { method: "DELETE" });
      if (!res.ok && res.status !== 404) await this.fail_(res, "delete");
    }
  }
  async list(options = {}) {
    const params = { list: "1", prefix: options.prefix || "", cursor: options.cursor || "", limit: String(options.limit || 1000) };
    const res = await this.store.fetch(this.url_(params), { method: "GET" });
    if (!res.ok) await this.fail_(res, "list");
    const r = await res.json();
    return { objects: (r.objects || []).map(r2Object), truncated: !!r.truncated, cursor: r.cursor, delimitedPrefixes: [] };
  }
}

export default function (env) {
  return new FilesBucket(env.STORE, env.BUCKET);
}
