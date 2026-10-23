/**
 * The send-agent relay's mailbox as a Durable Object — one globally consistent instance per environment.
 * ========================================================================
 * Why: the Cache API (agentRelay.js's fallback mailbox) is PER DATA CENTER. A phone and the shop's agent
 * usually reach different data centers, so the phone's job lands where the agent never looks: "agent
 * offline" or a timeout. A Durable Object is a single instance addressed by name from anywhere, so the
 * phone, the tablet and the agent all see the same state. No D1 involved.
 *
 * Same behaviour as the Cache API mailbox (same TTLs, once-only hand-out, max queue, jobs never run
 * late) and the same protocol with the agent. Plain fetch()-based class (no
 * "cloudflare:workers" import), so it also loads in Node tests.
 *
 * State is in this instance's memory AND its storage: an idle Durable Object is evicted between the agent's
 * once-a-minute polls, and the mailbox has to survive that. Presence and "hot" writes are throttled (they only
 * need to be fresher than their TTLs), so a polling agent costs about a storage write every 15 s at most.
 */

import { JOB_TTL_SEC, RESULT_TTL_SEC, PRESENCE_TTL_SEC, HOT_TTL_SEC, MAX_QUEUE } from "./agentRelay.js";

const PRESENCE_WRITE_EVERY_MS = 15_000;
const HOT_WRITE_EVERY_MS = 30_000;
const RESULT_PREFIX = "result:";
const OPS = new Set(["touchPresence", "getPresence", "setHot", "isHot", "enqueue", "claim", "hasPending",
  "putResult", "takeResult", "poll", "submit", "status"]);

export class AgentMailbox {
  constructor(state) {
    this.storage = state.storage;
    this.mem = new Map();          // key -> value (null = known absent); lost on eviction, reloaded from storage
    this.lastPresenceWrite = 0;
    this.lastHotWrite = 0;
  }

  async fetch(request) {
    let msg;
    try { msg = await request.json(); } catch { return new Response("bad request", { status: 400 }); }
    if (!msg || !OPS.has(msg.op)) return new Response("unknown op", { status: 400 });
    const result = await this[msg.op](...(Array.isArray(msg.args) ? msg.args : []));
    return new Response(JSON.stringify({ result: result === undefined ? null : result }), { headers: { "Content-Type": "application/json" } });
  }

  async get_(key) {
    if (this.mem.has(key)) return this.mem.get(key);
    const v = await this.storage.get(key);
    this.mem.set(key, v === undefined ? null : v);
    return this.mem.get(key);
  }
  async put_(key, value) { this.mem.set(key, value); await this.storage.put(key, value); }
  async del_(key) { this.mem.set(key, null); await this.storage.delete(key); }

  // ---- presence / hot ----
  async touchPresence(info) {
    const now = Date.now();
    const p = { at: now, ...(info || {}) };
    this.mem.set("presence", p);
    if (now - this.lastPresenceWrite >= PRESENCE_WRITE_EVERY_MS) { this.lastPresenceWrite = now; await this.storage.put("presence", p); }
  }
  // null when offline, else {lastSeenSec, ...what the agent reported}
  async getPresence() {
    const p = await this.get_("presence");
    if (!p || !p.at || Date.now() - p.at > PRESENCE_TTL_SEC * 1000) return null;
    return { ...p, lastSeenSec: Math.round((Date.now() - p.at) / 1000) };
  }
  async setHot() {
    const now = Date.now();
    this.mem.set("hot", { at: now });
    if (now - this.lastHotWrite >= HOT_WRITE_EVERY_MS) { this.lastHotWrite = now; await this.storage.put("hot", { at: now }); }
  }
  async isHot() {
    const h = await this.get_("hot");
    return !!(h && Date.now() - h.at < HOT_TTL_SEC * 1000);
  }

  // ---- queue ----
  async liveQueue_(now) {
    const q = await this.get_("queue");
    return Array.isArray(q) ? q.filter(j => j && now - j.issuedAt < JOB_TTL_SEC * 1000) : [];
  }
  // false when the queue is full
  async enqueue(job) {
    const now = Date.now();
    const q = await this.liveQueue_(now);
    if (q.length >= MAX_QUEUE) return false;
    q.push({ ...job, issuedAt: now });
    await this.put_("queue", q);
    await this.sweepResults_(now);
    return true;
  }
  // Oldest unexpired job, removed from the queue (handed out once), or null.
  async claim() {
    const q = await this.liveQueue_(Date.now());
    if (!q.length) { if (await this.get_("queue")) await this.del_("queue"); return null; }
    const job = q.shift();
    if (q.length) await this.put_("queue", q); else await this.del_("queue");
    return job;
  }
  async hasPending() { return (await this.liveQueue_(Date.now())).length > 0; }

  // ---- results (read once) ----
  async putResult(id, result) { await this.storage.put(RESULT_PREFIX + id, { ...result, at: Date.now() }); }
  async takeResult(id) {
    const r = await this.storage.get(RESULT_PREFIX + id);
    if (!r) return null;
    await this.storage.delete(RESULT_PREFIX + id);
    if (Date.now() - r.at > RESULT_TTL_SEC * 1000) return null;
    return { httpStatus: r.httpStatus, body: r.body };
  }
  // Results nobody collected are dropped when the next job comes in, so storage can't grow.
  async sweepResults_(now) {
    const old = await this.storage.list({ prefix: RESULT_PREFIX, limit: 50 });
    for (const [key, r] of old) if (!r || now - r.at > RESULT_TTL_SEC * 1000) await this.storage.delete(key);
  }

  // ---- combined operations: one round trip each (a poll would otherwise be four) ----
  // → {job, busy}: presence refreshed, the oldest job claimed, and whether the agent should keep polling fast.
  async poll(info) {
    await this.touchPresence(info);
    const job = await this.claim();
    const busy = (await this.isHot()) || (await this.hasPending());
    return { job, busy };
  }
  // → "ok" | "offline" | "full"
  async submit(job) {
    if (!(await this.getPresence())) return "offline";
    if (!(await this.enqueue(job))) return "full";
    await this.setHot();
    return "ok";
  }
  async status(hot) {
    if (hot) await this.setHot();
    return await this.getPresence();
  }
}
