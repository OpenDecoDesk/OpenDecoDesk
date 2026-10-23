/**
 * Short-lived mailbox between the admin pages and the local embroidery send-agent.
 * ========================================================================
 * The agent runs on a computer on the shop LAN and connects OUT to the site (a phone's HTTPS page
 * can't call a LAN address, and a Cloudflare Function can't reach one). This module is the
 * hand-off point: the browser drops a job in, the agent picks it up, drops a result back, the
 * browser reads it.
 *
 * Nothing here is long-lived on purpose — no D1. The mailbox is the AGENT_MAILBOX Durable Object when
 * that binding exists (agentMailbox.js), else the Cache API (the same mechanism as catalogCache.js);
 * either way every entry carries a lifetime, so a request that nobody picks up simply expires:
 *   presence  — the agent's last poll (90 s)      absent ⇒ agent offline
 *   queue     — pending jobs (each also checked against its own issuedAt; 120 s)
 *   result/id — the agent's answer (120 s), deleted when the browser reads it
 *   hot       — "someone is looking at a machine screen" (5 min) ⇒ the agent polls fast
 *
 * The Cache API fallback is per data centre: if phone and agent land on different ones, the job is
 * just never seen, the browser times out, and nothing ever runs late. Jobs are handed
 * out once, and an expired job is never returned — a design can't be sent to a machine hours later.
 * The Cache API queue is a read-modify-write of one entry (no atomic append), fine for one human and one agent.
 */

export const JOB_TTL_SEC = 120;
export const RESULT_TTL_SEC = 120;
export const PRESENCE_TTL_SEC = 90;
export const HOT_TTL_SEC = 300;
export const IDLE_POLL_SEC = 60;
export const HOT_POLL_SEC = 2;
export const MAX_QUEUE = 10;
const BASE = "https://agent-relay.internal/";

async function namespaceFor_(token){
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("odd-agent-relay:" + token));
  return Array.from(new Uint8Array(digest).slice(0, 8), b => b.toString(16).padStart(2, "0")).join("");
}

async function putJson_(key, obj, ttl){
  await caches.default.put(key, new Response(JSON.stringify(obj), {
    headers: { "Content-Type": "application/json", "Cache-Control": "max-age=" + ttl }
  }));
}
async function getJson_(key){
  const hit = await caches.default.match(key);
  if(!hit) return null;
  try{ return await hit.json(); }catch{ return null; }
}

// The mailbox. With the AGENT_MAILBOX Durable Object binding (the Worker; see agentMailbox.js) every device and the
// agent share ONE instance, so it works from anywhere. Without it (tests, or a deploy without the binding) it falls back to the Cache API
// below, which is per data centre. `token` only namespaces the mailbox (two environments never share one).
export async function openRelay(token, env){
  const ns = await namespaceFor_(token);
  if(env && env.AGENT_MAILBOX) return durableRelay_(env.AGENT_MAILBOX, ns);
  return cacheRelay_(ns);
}

// Every method is one round trip to the single Durable Object named after the token's namespace.
function durableRelay_(binding, ns){
  const stub = binding.get(binding.idFromName(ns));
  const call = async (op, ...args) => {
    const res = await stub.fetch("https://agent-mailbox.internal/", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ op, args }) });
    if(!res.ok) throw new Error("Agent mailbox " + op + " failed: HTTP " + res.status);
    return (await res.json()).result;
  };
  return {
    touchPresence: info => call("touchPresence", info),
    getPresence: () => call("getPresence"),
    setHot: () => call("setHot"),
    isHot: () => call("isHot"),
    enqueue: job => call("enqueue", job),
    claim: () => call("claim"),
    hasPending: () => call("hasPending"),
    putResult: (id, result) => call("putResult", id, result),
    takeResult: id => call("takeResult", id),
    poll: info => call("poll", info),
    submit: job => call("submit", job),
    status: hot => call("status", !!hot),
  };
}

// The Cache API mailbox (per data centre).
function cacheRelay_(ns){
  const k = name => BASE + ns + "/" + name;

  async function liveQueue_(now){
    const q = await getJson_(k("queue"));
    return Array.isArray(q) ? q.filter(j => j && now - j.issuedAt < JOB_TTL_SEC * 1000) : [];
  }

  const relay = {
    async touchPresence(info){
      await putJson_(k("presence"), { at: Date.now(), ...(info || {}) }, PRESENCE_TTL_SEC);
    },
    // → null when offline, else {lastSeenSec, ...info the agent reported}
    async getPresence(){
      const p = await getJson_(k("presence"));
      if(!p || !p.at || Date.now() - p.at > PRESENCE_TTL_SEC * 1000) return null;
      return { ...p, lastSeenSec: Math.round((Date.now() - p.at) / 1000) };
    },
    async setHot(){ await putJson_(k("hot"), { at: Date.now() }, HOT_TTL_SEC); },
    async isHot(){ return !!(await getJson_(k("hot"))); },

    // false when the queue is full.
    async enqueue(job){
      const now = Date.now();
      const q = await liveQueue_(now);
      if(q.length >= MAX_QUEUE) return false;
      q.push({ ...job, issuedAt: now });
      await putJson_(k("queue"), q, JOB_TTL_SEC);
      return true;
    },
    // Oldest unexpired job, removed from the queue (handed out once), or null.
    async claim(){
      const now = Date.now();
      const q = await liveQueue_(now);
      if(!q.length) return null;
      const job = q.shift();
      if(q.length) await putJson_(k("queue"), q, JOB_TTL_SEC);
      else await caches.default.delete(k("queue"));
      return job;
    },
    async hasPending(){ return (await liveQueue_(Date.now())).length > 0; },

    async putResult(id, result){ await putJson_(k("result/" + id), result, RESULT_TTL_SEC); },
    // Read once: returns the result and deletes it, or null if not there (yet).
    async takeResult(id){
      const r = await getJson_(k("result/" + id));
      if(r) await caches.default.delete(k("result/" + id));
      return r;
    },
  };
  // Combined operations, same contract as the Durable Object's.
  relay.poll = async (info) => {
    await relay.touchPresence(info);
    const job = await relay.claim();
    const busy = (await relay.isHot()) || (await relay.hasPending());
    return { job, busy };
  };
  relay.submit = async (job) => {
    if(!(await relay.getPresence())) return "offline";
    if(!(await relay.enqueue(job))) return "full";
    await relay.setHot();
    return "ok";
  };
  relay.status = async (hot) => { if(hot) await relay.setHot(); return relay.getPresence(); };
  return relay;
}
