const fs = require("fs");
const read = f => fs.readFileSync(__dirname + "/" + f, "utf8");
const strip = src => src.replace(/import \{[\s\S]*?\} from ["'][^"']+["'];\n?/g, "").replace(/export (async function|function|const)/g, "$1");

// Real agentRelay.js + real api/agent.js, with the admin gate / rate limiter / design signer stubbed.
let adminOk = true, hitBucket = [];
const relaySrc = strip(read("functions/_lib/agentRelay.js"));
const agentSrc = strip(read("functions/api/agent.js"));
const api = new Function("deps",
  "const {classifyHost, requireAdmin, timingSafeEqual, jsonResponse, rateLimited, rateLimitResponse, signedDesignPath, DESIGN_KEY_RE} = deps;\n" +
  "const featureIsOff = async () => false, featureOffResponse = () => null;\n" +
  relaySrc + "\n" + agentSrc + "\nreturn onRequestPost;")({
  classifyHost: h => ({ kind: /^(test)?admin\./.test(h) ? "admin" : "root" }),
  requireAdmin: async () => adminOk ? null : new Response(JSON.stringify({ status: "error", message: "Unauthorized" }), { status: 401 }),
  timingSafeEqual: (a, b) => a === b,
  jsonResponse: (o, s) => new Response(JSON.stringify(o), { status: s || 200, headers: { "Content-Type": "application/json" } }),
  rateLimited: async (env, bucket) => { hitBucket.push(bucket); return { blocked: false }; },
  rateLimitResponse: () => new Response("{}", { status: 429 }),
  signedDesignPath: async (env, key) => "/api/design?key=" + encodeURIComponent(key) + "&exp=1&sig=x",
  DESIGN_KEY_RE: /^(designs|order-files)\/[a-z0-9-]+\/[a-z0-9]{32}\.[a-z0-9]{1,10}$/,
});

// Cache API mock that honours Cache-Control max-age against a fake clock.
let now = 1_700_000_000_000; const realNow = Date.now; Date.now = () => now;
const store = new Map();
global.caches = { default: {
  async match(k){ const h = store.get(k); if(!h) return undefined; if(now > h.exp){ store.delete(k); return undefined; } return new Response(h.body); },
  async put(k, res){ const m = /max-age=(\d+)/.exec(res.headers.get("Cache-Control") || ""); store.set(k, { body: await res.text(), exp: now + (m ? Number(m[1]) : 0) * 1000 }); },
  async delete(k){ return store.delete(k); },
} };

const TOKEN = "t".repeat(40), KEY = "designs/9/" + "a".repeat(32) + ".dst";
const env = { AGENT_TOKEN: TOKEN };
async function call(op, body, { agent = true, host = "admin.example.com", token = TOKEN, e = env } = {}){
  const headers = new Map(); if(agent) headers.set("x-agent-token", token);
  const res = await api({ request: { url: `https://${host}/api/agent?op=${op}`, headers: { get: k => headers.has(k.toLowerCase()) ? headers.get(k.toLowerCase()) : null }, json: async () => body || {} }, env: e });
  return { status: res.status, data: JSON.parse(await res.text()) };
}
const browser = (op, body, o) => call(op, body, { agent: false, ...(o || {}) });

(async () => {
  console.log("=== Agent offline: nothing is queued ===");
  let r = await browser("status", {});
  console.log("status says offline before any poll:", r.data.online === false);
  r = await browser("submit", { type: "discover" });
  console.log("submit refused with agent_offline (503):", r.status === 503 && r.data.code === "agent_offline");

  console.log("\n=== Agent polls: idle cadence, presence, no job ===");
  r = await call("poll", { ip: "192.168.1.50", host: "pi", version: "2" });
  console.log("poll ok, no job, idle poll interval 60 s:", r.status === 200 && r.data.job === null && r.data.pollSeconds === 60);
  r = await browser("status", {});
  console.log("status now online with the agent's reported IP:", r.data.online === true && r.data.agentIp === "192.168.1.50");

  console.log("\n=== Job round trip: submit → claim (once) → result (read once) ===");
  r = await browser("submit", { type: "list", machineIp: "192.168.1.60", remoteDir: "/EMB" });
  const id = r.data.id;
  console.log("submit returns a job id:", r.status === 200 && /^[0-9a-f]{24}$/.test(id));
  r = await call("poll", {});
  console.log("agent gets the job and is told to poll fast:", r.data.job && r.data.job.id === id && r.data.job.type === "list" && r.data.job.machineIp === "192.168.1.60" && r.data.pollSeconds === 2);
  r = await call("poll", {});
  console.log("job is handed out only once:", r.data.job === null);
  r = await browser("result", { id });
  console.log("no result yet:", r.data.done === false);
  r = await call("result", { id, httpStatus: 200, body: { status: "ok", files: [{ name: "A.001" }] } });
  console.log("agent posts the result:", r.status === 200);
  r = await browser("result", { id });
  console.log("browser reads it:", r.data.done === true && r.data.result.httpStatus === 200 && r.data.result.body.files[0].name === "A.001");
  r = await browser("result", { id });
  console.log("and only once:", r.data.done === false);

  console.log("\n=== A send job gets its signed link at claim time, never carries the file key out ===");
  r = await browser("submit", { type: "send", machineIp: "192.168.1.60", fileKey: KEY, fileName: "logo<>.dst" });
  r = await call("poll", {});
  console.log("downloadUrl minted on the admin origin:", r.data.job.downloadUrl.startsWith("https://admin.example.com/api/design?key="));
  console.log("file name sanitised and fileKey not forwarded:", r.data.job.fileName === "logo.dst" && r.data.job.fileKey === undefined);

  console.log("\n=== A read job keeps the listed name, and its answer can carry a design ===");
  r = await browser("submit", { type: "read", machineIp: "192.168.1.60", fileName: "马头机~1.008" });
  const readId = r.data.id;
  r = await call("poll", {});
  console.log("read job handed to the agent with the name exactly as listed:", r.data.job && r.data.job.type === "read" && r.data.job.fileName === "马头机~1.008");
  await browser("submit", { type: "read", machineIp: "192.168.1.60", fileName: "Cap Front/../x\u0000.004" });
  r = await call("poll", {});
  console.log("…only control characters and path separators are dropped:", r.data.job.fileName === "Cap Front..x.004");
  console.log("a read without a name is refused:", (await browser("submit", { type: "read", machineIp: "192.168.1.60", fileName: " " })).status === 400);
  const design = "A".repeat(400 * 1024);   // a 300 KB design as base64
  r = await call("result", { id: readId, httpStatus: 200, body: { status: "ok", fileName: "x.008", ext: "DSB", dataBase64: design } });
  console.log("a 400 KB answer is accepted (the old cap was 64 KB):", r.status === 200);
  r = await browser("result", { id: readId });
  console.log("…and reaches the browser whole:", r.data.done === true && r.data.result.body.dataBase64.length === design.length);
  r = await call("result", { id: readId, httpStatus: 200, body: { dataBase64: "A".repeat(1_600_000) } });
  console.log("an answer over 1.5 MB is refused (413):", r.status === 413);

  console.log("\n=== Jobs expire: a job nobody picks up is never run later ===");
  r = await browser("submit", { type: "discover" });
  now += 121 * 1000;
  r = await call("poll", {});
  console.log("expired job is not returned:", r.data.job === null);
  console.log("agent that stopped polling reads as offline after 90 s:", (now += 100 * 1000, (await browser("status", {})).data.online === false));

  console.log("\n=== Hot flag speeds the agent up, then lapses ===");
  await call("poll", {});
  await browser("status", { hot: true });
  r = await call("poll", {});
  console.log("hot ⇒ 2 s polling:", r.data.pollSeconds === 2);
  now += 301 * 1000;
  r = await call("poll", {});
  console.log("hot lapsed after 5 minutes ⇒ back to 60 s:", r.data.pollSeconds === 60);

  console.log("\n=== Validation ===");
  await call("poll", {});
  const bad = async b => (await browser("submit", b)).status;
  console.log("unknown type refused:", await bad({ type: "rm" }) === 400);
  console.log("non-IPv4 machine refused:", await bad({ type: "list", machineIp: "evil.example" }) === 400);
  console.log("out-of-range octet refused:", await bad({ type: "list", machineIp: "192.168.1.300" }) === 400);
  console.log("send with a bad file key refused:", await bad({ type: "send", machineIp: "192.168.1.60", fileKey: "../../etc/passwd", fileName: "a.dst" }) === 400);
  console.log("send without a file name refused:", await bad({ type: "send", machineIp: "192.168.1.60", fileKey: KEY, fileName: "" }) === 400);

  console.log("\n=== Auth ===");
  hitBucket = [];
  r = await call("poll", {}, { token: "wrong".repeat(10) });
  console.log("wrong agent token ⇒ 401, counted on agent_auth:", r.status === 401 && hitBucket.join() === "agent_auth");
  r = await call("result", { id, httpStatus: 200, body: {} }, { token: "wrong".repeat(10) });
  console.log("wrong token can't post a result either:", r.status === 401);
  hitBucket = [];
  r = await call("poll", {});
  console.log("a healthy agent's poll never touches the rate limiter / D1:", r.status === 200 && hitBucket.length === 0);
  adminOk = false;
  r = await browser("submit", { type: "discover" });
  console.log("browser calls need the admin gate:", r.status === 401);
  adminOk = true;
  r = await call("poll", {}, { host: "acme.example.com" });
  console.log("storefront host refused:", r.status === 403);
  r = await call("poll", {}, { e: {} });
  console.log("relay disabled without AGENT_TOKEN:", r.status === 503);
  r = await call("poll", {}, { e: { AGENT_TOKEN: "short" } });
  console.log("a short AGENT_TOKEN is refused:", r.status === 503);

  console.log("\n=== Queue is bounded ===");
  await call("poll", {});
  let last; for(let i = 0; i < 12; i++) last = await browser("submit", { type: "discover" });
  console.log("11th+ queued job refused with 429:", last.status === 429);

  // ---- Browser side: the real admin.js helpers, loopback agent down, relay up ----
  console.log("\n=== admin.js: agentFetch_ falls back to the relay and returns a fetch-shaped reply ===");
  Date.now = realNow;
  const adminJs = read("public/admin.js");
  const block = adminJs.slice(adminJs.indexOf('const EMBROIDERY_AGENT_URL'), adminJs.indexOf("// A machine's LAN IP can change"));
  const calls = [];
  let relayOnline = true, answerAfter = 2;
  const fakeFetch = async (url, opts) => {
    calls.push(url);
    if (url.startsWith("http://127.0.0.1")) throw new TypeError("Failed to fetch");
    const op = /op=(\w+)/.exec(url)[1], body = JSON.parse(opts.body || "{}");
    const ok = o => ({ ok: true, status: 200, json: async () => o });
    if (op === "status") return ok({ status: "ok", online: relayOnline });
    if (op === "submit") return relayOnline ? ok({ status: "ok", id: "abc" }) : { ok: false, status: 503, json: async () => ({ status: "error", message: "agent offline" }) };
    if (op === "result") return ok(--answerAfter > 0 ? { status: "ok", done: false } : { status: "ok", done: true, result: { httpStatus: 200, body: { status: "ok", files: [{ name: "X.001" }] } } });
  };
  const sub = [];
  const helpers = new Function("fetch", "setTimeout", "adminKey", "submitLog",
    block + "\nreturn { agentFetch_, checkSendAgent_ };")(
      fakeFetch, (fn) => fn(), "cookie", sub);
  let reply = await helpers.agentFetch_("/list", { method: "POST", body: JSON.stringify({ machineIp: "192.168.1.60", remoteDir: "/EMB" }) });
  let data = await reply.json();
  console.log("list over the relay resolves like a fetch Response:", reply.ok && data.files[0].name === "X.001");
  console.log("it tried the loopback agent first, then submit + result polls:", calls[0].includes("127.0.0.1") && calls.some(u => u.includes("op=submit")) && calls.filter(u => u.includes("op=result")).length === 2);
  console.log("online relay ⇒ agent counts as connected:", await helpers.checkSendAgent_() === true);
  relayOnline = false;
  console.log("offline relay ⇒ not connected:", await helpers.checkSendAgent_() === false);
  let threw = ""; try { await helpers.agentFetch_("/discover", { method: "GET" }); } catch (e) { threw = e.message; }
  console.log("a refused submit surfaces the server's message:", threw === "agent offline");
})();
