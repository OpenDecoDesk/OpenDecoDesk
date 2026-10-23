const fs = require("fs");

// ---- shared lib ----
let libSrc = fs.readFileSync(__dirname + "/functions/_lib/hostConfig.js", "utf8")
  .replace(/export const/g, "const").replace(/export function/g, "function");

// ---- upload.js ----
let rateLimitSrc = fs.readFileSync(__dirname + "/functions/_lib/rateLimit.js", "utf8")
  .replace(/export async function/g, "async function")
  .replace(/export function/g, "function");
// adminAuth.js imports access.js (optional Cloudflare Access check) — load both.
let adminAuthSrc = (fs.readFileSync(__dirname + "/functions/_lib/access.js", "utf8") + "\n" +
    fs.readFileSync(__dirname + "/functions/_lib/adminAuth.js", "utf8"))
  .replace(/import \{[\s\S]*?\} from ["'][^"']+["'];\n?/g, "")
  .replace(/export const/g, "const")
  .replace(/import \{ rateLimited, rateLimitResponse \} from ["'].*["'];\n?/, "")
  .replace(/import \{ jsonResponse \} from ["'].*["'];\n?/, "")
  .replace(/export async function/g, "async function")
  .replace(/export function/g, "function");
let httpSrc = fs.readFileSync(__dirname + "/functions/_lib/http.js", "utf8")
  .replace(/export function/g, "function");
let uploadSrc = fs.readFileSync(__dirname + "/functions/_lib/fileUpload.js", "utf8").replace(/export (async function|function)/g, "$1") + "\n" +
  fs.readFileSync(__dirname + "/functions/api/upload.js", "utf8")
  .replace(/import \{ classifyHost \} from ["'].*["'];\n?/, "")
  .replace(/import \{ requireAdmin \} from ["'].*["'];\n?/, "")
  .replace(/import \{ jsonResponse \} from ["'].*["'];\n?/, "")
  .replace(/import \{ readBodyWithLimit, hasValidMagicBytes \} from ["'].*["'];\n?/, "")
  .replace(/export async function/g, "async function");
eval(libSrc + "\n" + rateLimitSrc + "\n" + adminAuthSrc + "\n" + httpSrc + "\n" + uploadSrc);
const uploadHandler = onRequestPost;

// Records what got put into R2 so we can assert on the key/options.
function makeEnv(overrides){
  const puts = [];
  const env = Object.assign({
    PROXY_ADMIN_PASSPHRASE: "proxy-pass",
    R2_PUBLIC_BASE: "https://images.example.com",
    IMAGES: { put: async (key, body, opts) => { puts.push({key, body, opts}); } }
  }, overrides || {});
  env.__puts = puts;
  return env;
}

// Creates an ArrayBuffer of the given size with valid magic bytes for the type
// at the front, so upload.js's hasValidMagicBytes() accepts it.
function validBuf(contentType, size){
  const buf = new ArrayBuffer(Math.max(12, size || 12));
  const b = new Uint8Array(buf);
  const ct = contentType.split(";")[0].trim();
  if(ct === "image/jpeg")  { b[0]=0xFF; b[1]=0xD8; b[2]=0xFF; }
  if(ct === "image/png")   { b[0]=0x89; b[1]=0x50; b[2]=0x4E; b[3]=0x47; }
  if(ct === "image/webp")  { b[0]=0x52; b[1]=0x49; b[2]=0x46; b[3]=0x46; b[8]=0x57; b[9]=0x45; b[10]=0x42; b[11]=0x50; }
  if(ct === "image/gif")   { b[0]=0x47; b[1]=0x49; b[2]=0x46; b[3]=0x38; b[4]=0x39; b[5]=0x61; }
  return buf;
}

// Builds a fake request the way the raw-body upload.js reads it: image
// bytes as the body (arrayBuffer), image type + admin key in headers, org
// in the query string. Pass opts.body to supply a specific ArrayBuffer;
// otherwise a zeroed buffer of opts.size bytes is used.
function ctx(opts, env){
  const headers = new Map();
  if(opts.key !== undefined) headers.set("x-admin-key", opts.key);
  if(opts.contentType !== undefined) headers.set("content-type", opts.contentType);
  const org = opts.org !== undefined ? "?org=" + encodeURIComponent(opts.org) : "";
  const base = opts.url || "https://admin.example.com/api/upload";
  return {
    request: {
      url: base + org,
      headers: { get: (k) => (headers.has(String(k).toLowerCase()) ? headers.get(String(k).toLowerCase()) : null) },
      arrayBuffer: async () => opts.body !== undefined ? opts.body : new ArrayBuffer(opts.size == null ? 0 : opts.size)
    },
    env: env
  };
}

// crypto.randomUUID is used by upload.js for the object key.
if(!global.crypto) global.crypto = {};
if(!global.crypto.randomUUID) global.crypto.randomUUID = () => "11111111-2222-3333-4444-555555555555";

(async () => {
  console.log("=== upload.js: happy path — admin subdomain + right passphrase + valid image → stored in R2, public URL + uploadId returned ===");
  let env = makeEnv();
  let res = await uploadHandler(ctx({key:"proxy-pass", org:"league-101", contentType:"image/png", body:validBuf("image/png",1234)}, env));
  let data = JSON.parse(await res.text());
  console.log("Returns ok:", data.status === "ok");
  console.log("Returns a public URL under R2_PUBLIC_BASE:", data.url && data.url.indexOf("https://images.example.com/") === 0);
  console.log("Key is under uploads/<org>/ and ends with the content-type's extension (.png), not a client-picked name:",
    /^https:\/\/images\.example\.com\/uploads\/league-101\/[a-z0-9]+\.png$/i.test(data.url));
  console.log("Returns uploadId (32-char hex, no dashes) so client can upload thumbnail:", /^[a-f0-9]{32}$/.test(data.uploadId || ""));
  console.log("Exactly one object written to R2:", env.__puts.length === 1);
  console.log("R2 object stored with the request's content type:", env.__puts[0].opts.httpMetadata.contentType === "image/png");
  console.log("R2 object stored with a long immutable cache header:", /immutable/.test(env.__puts[0].opts.httpMetadata.cacheControl));

  console.log("\n=== Thumbnail upload: ?thumbFor=<id> stores a -thumb variant alongside the main image ===");
  env = makeEnv();
  const mainId = "a".repeat(32); // simulate the uploadId from a prior main upload
  // Pass full URL without a separate org field to avoid ctx() double-appending ?org=
  res = await uploadHandler(ctx({key:"proxy-pass", contentType:"image/jpeg", body:validBuf("image/jpeg",400),
    url:"https://admin.example.com/api/upload?org=league-101&thumbFor=" + mainId}, env));
  data = JSON.parse(await res.text());
  console.log("Thumb upload returns ok:", data.status === "ok");
  console.log("Thumb key ends with -thumb.jpg:", /\/uploads\/league-101\/[a-f0-9]{32}-thumb\.jpg$/.test(data.url));
  console.log("Thumb upload does NOT return uploadId (no further thumbs of thumbs):", !("uploadId" in data));
  console.log("Exactly one object written to R2:", env.__puts.length === 1);

  console.log("\n=== Thumb upload: invalid thumbFor value → 400, nothing written ===");
  env = makeEnv();
  res = await uploadHandler(ctx({key:"proxy-pass", contentType:"image/png", body:validBuf("image/png",10),
    url:"https://admin.example.com/api/upload?org=x&thumbFor=../../etc/passwd"}, env));
  data = JSON.parse(await res.text());
  console.log("Bad thumbFor → 400:", res.status === 400 && /Invalid/.test(data.message));
  console.log("Nothing written:", env.__puts.length === 0);

  console.log("\n=== Extension is derived from content type, not filename (jpeg → jpg); charset param on the header is tolerated ===");
  env = makeEnv();
  res = await uploadHandler(ctx({key:"proxy-pass", org:"rec", contentType:"image/jpeg; charset=binary", body:validBuf("image/jpeg",500)}, env));
  data = JSON.parse(await res.text());
  console.log("jpeg stored as .jpg:", /\.jpg$/.test(data.url));

  console.log("\n=== Rejected from a non-admin (storefront) subdomain, even with the right passphrase — never writes to R2 ===");
  env = makeEnv();
  res = await uploadHandler(ctx({key:"proxy-pass", org:"x", contentType:"image/png", size:10, url:"https://league101.example.com/api/upload"}, env));
  data = JSON.parse(await res.text());
  console.log("Refused with 403:", res.status === 403 && data.status === "error");
  console.log("Nothing written to R2:", env.__puts.length === 0);

  console.log("\n=== Wrong passphrase → 401, nothing written, body never even read ===");
  env = makeEnv();
  res = await uploadHandler(ctx({key:"wrong", org:"x", contentType:"image/png", size:10}, env));
  data = JSON.parse(await res.text());
  console.log("Refused with 401:", res.status === 401 && data.message === "Unauthorized");
  console.log("Nothing written to R2:", env.__puts.length === 0);

  console.log("\n=== Disallowed content type (e.g. SVG/PDF) is rejected, nothing written ===");
  env = makeEnv();
  res = await uploadHandler(ctx({key:"proxy-pass", org:"x", contentType:"image/svg+xml", size:10}, env));
  data = JSON.parse(await res.text());
  console.log("SVG rejected:", res.status === 400 && /Unsupported/.test(data.message));
  console.log("Nothing written to R2:", env.__puts.length === 0);

  console.log("\n=== Oversized body is rejected on the ACTUAL bytes, before writing to R2 ===");
  env = makeEnv();
  res = await uploadHandler(ctx({key:"proxy-pass", org:"x", contentType:"image/png", size:6 * 1024 * 1024}, env));
  data = JSON.parse(await res.text());
  console.log("Too-large rejected:", res.status === 400 && /too large/i.test(data.message));
  console.log("Nothing written to R2:", env.__puts.length === 0);

  console.log("\n=== Empty body → clean 400 'No file' ===");
  env = makeEnv();
  res = await uploadHandler(ctx({key:"proxy-pass", org:"x", contentType:"image/png", size:0}, env));
  data = JSON.parse(await res.text());
  console.log("Empty upload rejected:", res.status === 400 && /No file/.test(data.message));

  console.log("\n=== Wrong magic bytes → 415, nothing written (Content-Type says PNG but bytes are zeros) ===");
  env = makeEnv();
  res = await uploadHandler(ctx({key:"proxy-pass", org:"x", contentType:"image/png", size:100}, env)); // size:100 → all-zero buffer, no magic
  data = JSON.parse(await res.text());
  console.log("Mismatched bytes rejected with 415:", res.status === 415);
  console.log("Nothing written to R2:", env.__puts.length === 0);

  console.log("\n=== Not configured (no R2 binding / no public base) → 500, nothing attempted ===");
  res = await uploadHandler(ctx({key:"proxy-pass", org:"x", contentType:"image/png", size:10}, makeEnv({IMAGES: undefined})));
  console.log("Missing IMAGES binding → 500:", res.status === 500);
  res = await uploadHandler(ctx({key:"proxy-pass", org:"x", contentType:"image/png", size:10}, makeEnv({R2_PUBLIC_BASE: undefined})));
  console.log("Missing R2_PUBLIC_BASE → 500:", res.status === 500);

  console.log("\n=== A weird org value can't escape the uploads/ prefix (sanitized to safe chars) ===");
  env = makeEnv();
  res = await uploadHandler(ctx({key:"proxy-pass", org:"../../etc/passwd", contentType:"image/png", body:validBuf("image/png",10)}, env));
  data = JSON.parse(await res.text());
  console.log("Key still under uploads/ with a sanitized folder, no path traversal:",
    /^https:\/\/images\.example\.com\/uploads\/[a-z0-9-]*\/[a-z0-9]+\.png$/i.test(data.url) && data.url.indexOf("..") === -1);

  console.log("\n=== GET is not allowed ===");
  const getRes = await onRequestGet();
  console.log("GET → 405:", getRes.status === 405);

  // ========================
  // Body-buffering DoS guard — the size cap must be enforced WHILE reading,
  // never by buffering the whole body first (request.arrayBuffer() before
  // any size check would let an attacker stream unbounded data into
  // Worker memory before rejection).
  // ========================
  function makeStreamBody(totalChunks, chunkSize, firstChunk){
    let consumed = 0, cancelled = false;
    return {
      getReader(){
        return {
          async read(){
            if(cancelled || consumed >= totalChunks) return { done: true, value: undefined };
            const chunk = (consumed === 0 && firstChunk) ? firstChunk : new Uint8Array(chunkSize);
            consumed++;
            return { done: false, value: chunk };
          },
          async cancel(){ cancelled = true; }
        };
      },
      _stats: () => ({ consumed, cancelled })
    };
  }
  function ctxStream(opts, env){
    const headers = new Map();
    if(opts.key !== undefined) headers.set("x-admin-key", opts.key);
    if(opts.contentType !== undefined) headers.set("content-type", opts.contentType);
    if(opts.contentLength !== undefined) headers.set("content-length", String(opts.contentLength));
    const org = opts.org !== undefined ? "?org=" + encodeURIComponent(opts.org) : "";
    const base = opts.url || "https://admin.example.com/api/upload";
    return {
      request: {
        url: base + org,
        headers: { get: (k) => (headers.has(String(k).toLowerCase()) ? headers.get(String(k).toLowerCase()) : null) },
        body: opts.body,
        arrayBuffer: async () => { throw new Error("arrayBuffer() should not be called when a stream body is present"); }
      },
      env
    };
  }

  console.log("\n=== Content-Length alone rejects an oversized claim WITHOUT ever touching the body stream ===");
  let bodyTouched = false;
  env = makeEnv();
  const clOnlyReq = ctxStream({key:"proxy-pass", org:"x", contentType:"image/png", contentLength: 50 * 1024 * 1024}, env);
  Object.defineProperty(clOnlyReq.request, "body", { get(){ bodyTouched = true; return null; } });
  res = await uploadHandler(clOnlyReq);
  data = JSON.parse(await res.text());
  console.log("Rejected as too large:", res.status === 400 && /too large/i.test(data.message));
  console.log("The body stream was never even accessed:", !bodyTouched);
  console.log("Nothing written to R2:", env.__puts.length === 0);

  console.log("\n=== A body that WOULD be 1000MB if fully consumed gets cut off after crossing the 5MB cap, not after reading it all ===");
  env = makeEnv();
  const bigBody = makeStreamBody(1000, 1024 * 1024); // 1000 chunks x 1MB = 1000MB if fully drained
  res = await uploadHandler(ctxStream({key:"proxy-pass", org:"x", contentType:"image/png", body: bigBody}, env));
  data = JSON.parse(await res.text());
  const stats = bigBody._stats();
  console.log("Rejected as too large:", res.status === 400 && /too large/i.test(data.message));
  console.log("Stream was cancelled (signals the client to stop sending):", stats.cancelled === true);
  console.log("Far fewer than all 1000 chunks were read before bailing (proves no full-body buffering):", stats.consumed < 10);
  console.log("Nothing written to R2:", env.__puts.length === 0);

  console.log("\n=== A body within the limit, delivered as a stream, still uploads successfully ===");
  env = makeEnv();
  const smallBody = makeStreamBody(3, 100 * 1024, new Uint8Array(validBuf("image/png", 100 * 1024))); // 3 x 100KB, first chunk has valid PNG magic
  res = await uploadHandler(ctxStream({key:"proxy-pass", org:"league-101", contentType:"image/png", body: smallBody}, env));
  data = JSON.parse(await res.text());
  console.log("Uploads successfully:", data.status === "ok");
  console.log("Stream was NOT cancelled (fully consumed normally):", smallBody._stats().cancelled === false);
  console.log("Exactly one object written to R2:", env.__puts.length === 1);
})();
