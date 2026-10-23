const fs = require("fs");

// The send-agent relay's mailbox as a Durable Object (functions/_lib/agentMailbox.js). The Cache API fallback is
// per data centre, so a phone and the shop's agent may never see each other's jobs. This proves the Durable
// Object behaves like the Cache API mailbox (TTLs, once-only hand-out, max queue, jobs never run late), survives being
// evicted between the agent's polls, that two clients really share one mailbox, and that the whole relay flow
// (real api/agent.js) works with NO Cache API at all.

const read = (f) => fs.readFileSync(__dirname + "/" + f, "utf8");
const strip = (src) => src.replace(/import \{[\s\S]*?\} from ["'][^"']+["'];\n?/g, "").replace(/export (async function|function|const|class)/g, "$1");

// A fake Durable Object runtime: storage is a Map that outlives an instance ("eviction" = a new instance on the same storage).
function fakeStorage() {
  const m = new Map(); let writes = 0;
  return { m, get writes() { return writes; },
    async get(k) { return m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : undefined; },
    async put(k, v) { writes++; m.set(k, JSON.parse(JSON.stringify(v))); },
    async delete(k) { m.delete(k); },
    async list({ prefix = "", limit = 1000 } = {}) { return new Map([...m].filter(([k]) => k.startsWith(prefix)).slice(0, limit)); } };
}
let now = 1_700_000_000_000; Date.now = () => now;

(async () => {
  const { AgentMailbox } = await import("./functions/_lib/agentMailbox.js");
  const { openRelay } = await import("./functions/_lib/agentRelay.js");
  const storage = fakeStorage();
  let box = new AgentMailbox({ storage });
  const evict = () => { box = new AgentMailbox({ storage }); };
  const rpc = async (op, ...args) => JSON.parse(await (await box.fetch(new Request("https://x/", { method: "POST", body: JSON.stringify({ op, args }) }))).text()).result;

  console.log("=== Presence ===");
  console.log("offline before any poll:", (await rpc("getPresence")) === null);
  await rpc("touchPresence", { agentIp: "192.168.1.70", host: "mac" });
  let p = await rpc("getPresence");
  console.log("online after a poll, with what the agent reported:", p && p.agentIp === "192.168.1.70" && p.lastSeenSec === 0);
  now += 89_000; console.log("still online 89 s later:", !!(await rpc("getPresence")));
  now += 2_000; console.log("offline after 90 s of silence:", (await rpc("getPresence")) === null);

  console.log("\n=== Eviction between polls (an idle Durable Object is dropped from memory) ===");
  await rpc("touchPresence", { agentIp: "10.0.0.5" });
  evict();
  p = await rpc("getPresence");
  console.log("presence survives the instance being evicted:", p && p.agentIp === "10.0.0.5");
  const w0 = storage.writes; for (let i = 0; i < 10; i++) { now += 2_000; await rpc("touchPresence", {}); }
  console.log("a fast-polling agent (every 2 s) costs storage writes only every 15 s, not per poll:", storage.writes - w0 <= 2);

  console.log("\n=== The queue ===");
  const s0 = await rpc("submit", { id: "j1", type: "list", machineIp: "192.168.0.50" });
  console.log("submit while the agent is online → ok:", s0 === "ok");
  await rpc("enqueue", { id: "j2", type: "discover" });
  evict();
  const got = await rpc("claim");
  console.log("the oldest job comes out first, once, even after an eviction:", got && got.id === "j1" && (await rpc("claim")).id === "j2" && (await rpc("claim")) === null);
  await rpc("enqueue", { id: "old", type: "discover" });
  now += 121_000;
  console.log("a job nobody claimed in 120 s is never handed out (a design can't be sent late):", (await rpc("claim")) === null && (await rpc("hasPending")) === false);
  let accepted = 0; for (let i = 0; i < 12; i++) if (await rpc("enqueue", { id: "q" + i, type: "discover" })) accepted++;
  console.log("the queue holds at most 10:", accepted === 10);
  while (await rpc("claim")) { /* drain */ }

  console.log("\n=== Combined operations (one round trip each) ===");
  now += 400_000;   // agent has gone quiet (and any earlier "hot" flag has run out)
  console.log("submit while the agent is offline → 'offline' (nothing queued):", (await rpc("submit", { id: "x", type: "discover" })) === "offline" && (await rpc("hasPending")) === false);
  let r = await rpc("poll", { agentIp: "1.2.3.4" });
  console.log("poll: presence refreshed, no job, not busy:", r.job === null && r.busy === false && !!(await rpc("getPresence")));
  await rpc("submit", { id: "j9", type: "list", machineIp: "192.168.0.50" });
  r = await rpc("poll", { agentIp: "1.2.3.4" });
  console.log("poll hands the job over and reports busy (hot after a submit):", r.job && r.job.id === "j9" && r.busy === true);
  console.log("status(hot) reports presence and sets hot:", (await rpc("status", true)).agentIp === "1.2.3.4" && (await rpc("isHot")) === true);
  now += 301_000; await rpc("touchPresence", {});
  console.log("hot expires after 5 minutes:", (await rpc("isHot")) === false);

  console.log("\n=== Results (read once, expire) ===");
  await rpc("putResult", "r1", { httpStatus: 200, body: { status: "ok", files: [1, 2] } });
  evict();
  const t1 = await rpc("takeResult", "r1");
  console.log("a result survives an eviction and comes back once:", t1 && t1.httpStatus === 200 && t1.body.files.length === 2 && (await rpc("takeResult", "r1")) === null);
  await rpc("putResult", "r2", { httpStatus: 200, body: {} });
  now += 121_000;
  console.log("a result nobody collected expires:", (await rpc("takeResult", "r2")) === null);
  await rpc("putResult", "stale", { httpStatus: 200, body: {} }); now += 121_000;
  await rpc("touchPresence", {}); await rpc("enqueue", { id: "n", type: "discover" });
  console.log("uncollected results are swept when the next job comes in (storage can't grow):", ![...storage.m.keys()].some(k => k === "result:stale"));

  console.log("\n=== Two clients share ONE mailbox (the whole point) ===");
  const instances = new Map();
  const ns = { idFromName: (n) => n, get: (id) => { if (!instances.has(id)) instances.set(id, new AgentMailbox({ storage: fakeStorage() })); const b = instances.get(id);
    return { fetch: (url, init) => b.fetch(new Request(url, init)) }; } };
  const phone = await openRelay("T".repeat(40), { AGENT_MAILBOX: ns }), agent = await openRelay("T".repeat(40), { AGENT_MAILBOX: ns });
  global.caches = { default: { async match() { throw new Error("Cache API must not be used"); }, async put() { throw new Error("Cache API must not be used"); }, async delete() { throw new Error("Cache API must not be used"); } } };
  await agent.poll({ agentIp: "192.168.1.70" });
  console.log("the phone sees the agent that polled through a different client:", (await phone.status(false)).agentIp === "192.168.1.70");
  console.log("the phone's job reaches the agent:", (await phone.submit({ id: "pj", type: "discover" })) === "ok" && (await agent.poll({})).job.id === "pj");
  await agent.putResult("pj", { httpStatus: 200, body: { machines: [] } });
  console.log("and the agent's result reaches the phone:", (await phone.takeResult("pj")).body.machines.length === 0);
  const other = await openRelay("U".repeat(40), { AGENT_MAILBOX: ns });
  console.log("a different token (another environment) gets its own mailbox:", (await other.status(false)) === null);
  delete global.caches;

  console.log("\n=== Without the binding it falls back to the Cache API (no binding / tests) ===");
  const store = new Map();
  global.caches = { default: { async match(k) { const h = store.get(k); return h ? new Response(h) : undefined; }, async put(k, res) { store.set(k, await res.text()); }, async delete(k) { return store.delete(k); } } };
  const cacheRelay = await openRelay("V".repeat(40), {});
  await cacheRelay.poll({ agentIp: "9.9.9.9" });
  console.log("the Cache API mailbox still works with the same combined calls:", (await cacheRelay.status(false)).agentIp === "9.9.9.9" && (await cacheRelay.submit({ id: "c1", type: "discover" })) === "ok" && (await cacheRelay.poll({})).job.id === "c1");
  delete global.caches;

  console.log("\n=== End to end through the real api/agent.js, Durable Object only (no Cache API) ===");
  const agentSrc = strip(read("functions/api/agent.js")), relaySrc = strip(read("functions/_lib/agentRelay.js"));
  const api = new Function("deps", "const {classifyHost, requireAdmin, timingSafeEqual, jsonResponse, rateLimited, rateLimitResponse, signedDesignPath, DESIGN_KEY_RE} = deps;\n" +
  "const featureIsOff = async () => false, featureOffResponse = () => null;\n" + relaySrc + "\n" + agentSrc + "\nreturn onRequestPost;")({
    classifyHost: h => ({ kind: /^(test)?admin\./.test(h) ? "admin" : "root" }), requireAdmin: async () => null, timingSafeEqual: (a, b) => a === b,
    jsonResponse: (o, s) => new Response(JSON.stringify(o), { status: s || 200, headers: { "Content-Type": "application/json" } }),
    rateLimited: async () => ({ blocked: false }), rateLimitResponse: () => new Response("{}", { status: 429 }),
    signedDesignPath: async (env, key) => "/api/design?key=" + key, DESIGN_KEY_RE: /^(designs|order-files)\/[a-z0-9-]+\/[a-z0-9]{32}\.[a-z0-9]{1,10}$/ });
  const TOKEN = "t".repeat(40), env = { AGENT_TOKEN: TOKEN, AGENT_MAILBOX: ns };
  const call = async (op, body, agentSide) => { const h = new Map(); if (agentSide) h.set("x-agent-token", TOKEN);
    const res = await api({ request: { url: "https://admin.example.com/api/agent?op=" + op, headers: { get: k => h.has(k.toLowerCase()) ? h.get(k.toLowerCase()) : null }, json: async () => body }, env });
    return { status: res.status, data: JSON.parse(await res.text()) }; };
  let e = await call("status", {}, false);
  console.log("before any poll: offline, and a submit is refused:", e.data.online === false && (await call("submit", { type: "discover" }, false)).status === 503);
  await call("poll", { ip: "192.168.1.70", host: "mac" }, true);
  e = await call("status", {}, false);
  console.log("after the agent polls: online with its address:", e.data.online === true && e.data.agentIp === "192.168.1.70");
  const sub = await call("submit", { type: "send", machineIp: "192.168.0.50", fileKey: "designs/9/" + "a".repeat(32) + ".dst", fileName: "cap.dst" }, false);
  const pol = await call("poll", {}, true);
  console.log("a send job reaches the agent with a freshly signed download link:", sub.status === 200 && pol.data.job && pol.data.job.id === sub.data.id && /^https:\/\/admin\.example\.com\/api\/design\?key=/.test(pol.data.job.downloadUrl) && pol.data.pollSeconds === 2);
  await call("result", { id: sub.data.id, httpStatus: 200, body: { status: "ok", bytes: 123 } }, true);
  const res = await call("result", { id: sub.data.id }, false);
  console.log("the result comes back to the phone, once:", res.data.done === true && res.data.result.body.bytes === 123 && (await call("result", { id: sub.data.id }, false)).data.done === false);
})().catch((e) => { console.log("test89 crashed:", false); console.error(e); process.exit(1); });
