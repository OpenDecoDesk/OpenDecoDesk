// Relay between the admin pages and the local embroidery send-agent (the OpenDecoDesk machine agent
// in --relay mode). The agent runs on the shop LAN and connects OUT to this endpoint; the browser
// (phone, tablet or laptop) never talks to the agent directly. Jobs and results live only in the
// relay's short-lived mailbox for ~2 minutes (functions/_lib/agentRelay.js) — nothing is written to
// D1 or R2, and a job nobody picks up expires instead of running later.
//
// Agent side — header X-Agent-Token (env AGENT_TOKEN, a long random string, ≥ 32 chars):
//   POST ?op=poll   body {ip?, host?, version?} → {status, job|null, pollSeconds}
//        Refreshes the agent's presence; hands out the oldest unexpired job (once). For a send job
//        the signed 60 s download link is minted here, at claim time.
//   POST ?op=result body {id, httpStatus, body} → {status}   the agent's answer to a job.
// Browser side — admin subdomain + requireAdmin, exactly like every other admin endpoint:
//   POST ?op=status body {hot?}  → {status, online, lastSeenSec, agentIp}   hot:true = a machine
//        screen is open, so the agent polls fast for the next 5 minutes.
//   POST ?op=submit body {type: discover|list|send|read|delete, machineIp, remoteDir, fileKey, fileName}
//        → {status, id}   refused at once ("agent offline") when no agent has polled lately.
//   POST ?op=result body {id}    → {status, done, result?}   read once.
//
// A bad agent token is counted on the shared `agent_auth` bucket — that is the only path that touches
// D1 (the budget is checked after the token, which is fine for a 32+ character random secret); a
// healthy agent's polls cost no D1 reads or writes at all.

import { classifyHost } from "../_lib/hostConfig.js";
import { requireAdmin, timingSafeEqual } from "../_lib/adminAuth.js";
import { jsonResponse, featureOffResponse, featureIsOff } from "../_lib/http.js";
import { rateLimited, rateLimitResponse } from "../_lib/rateLimit.js";
import { openRelay, IDLE_POLL_SEC, HOT_POLL_SEC } from "../_lib/agentRelay.js";
import { signedDesignPath, DESIGN_KEY_RE } from "./design.js";

const JOB_TYPES = new Set(["discover", "list", "send", "read", "delete"]);
const ID_RE = /^[0-9a-f]{24}$/;
// A read job's answer carries the file (base64), so results can be big: 1.5 MB fits a design of ~1.1 MB and stays
// under a Durable Object's 2 MB value limit. The agent refuses a bigger read itself, with a plain message.
const MAX_RESULT_BYTES = 1_500_000;
const AGENT_AUTH_BUCKET = "agent_auth";
const AGENT_AUTH_LIMIT = 10;
const MIN_TOKEN_LENGTH = 32;

function err(message, status, extra){ return jsonResponse({ status: "error", message, ...(extra || {}) }, status); }

function validIPv4(s){
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(s || ""));
  return !!m && m.slice(1).every(n => Number(n) <= 255);
}

// Whitelists and bounds everything the browser put in a job (the agent re-validates too).
function cleanJob(body){
  const type = String((body && body.type) || "");
  if(!JOB_TYPES.has(type)) return { error: "Unknown job type." };
  const job = { type };
  if(type !== "discover"){
    if(!validIPv4(body.machineIp)) return { error: "Machine IP must be an IPv4 address." };
    job.machineIp = String(body.machineIp);
    const dir = String(body.remoteDir || "/EMB");
    job.remoteDir = /^[\w\/.-]{1,60}$/.test(dir) ? dir : "/EMB";
  }
  if(type === "send"){
    if(!DESIGN_KEY_RE.test(String(body.fileKey || ""))) return { error: "Invalid file reference." };
    job.fileKey = String(body.fileKey);
  }
  if(type === "read"){
    // The name exactly as the machine lists it ("LOGO.012", even "马头机~1.008"): only control characters and
    // path separators are dropped — the machine looks the file up by that exact string.
    const name = String(body.fileName || "").replace(/[\u0000-\u001f\u007f\/\\]/g, "").trim().slice(0, 160);
    if(!name) return { error: "Missing file name." };
    job.fileName = name;
  }
  if(type === "send" || type === "delete"){
    const name = String(body.fileName || "").replace(/[^\w .()-]/g, "").trim().slice(0, 120);
    if(!name) return { error: "Missing file name." };
    job.fileName = name;
  }
  return { job };
}

export async function onRequestPost({ request, env }){
  const url = new URL(request.url);
  const host = classifyHost(url.hostname, null, env);
  if(host.kind !== "admin") return err("Not available here.", 403);

  const token = String(env.AGENT_TOKEN || "");
  if(token.length < MIN_TOKEN_LENGTH) return err("The send-agent relay isn't set up (AGENT_TOKEN).", 503);

  let body;
  try{ body = await request.json(); }catch{ body = {}; }
  if(!body || typeof body !== "object") body = {};
  const op = url.searchParams.get("op") || "";
  const relay = await openRelay(token, env);

  // ---- Agent → site ----
  if(op === "poll" || (op === "result" && request.headers.get("X-Agent-Token") !== null)){
    if(!timingSafeEqual(request.headers.get("X-Agent-Token") || "", token)){
      const rl = await rateLimited(env, AGENT_AUTH_BUCKET, request, AGENT_AUTH_LIMIT);
      return rl.blocked ? rateLimitResponse(rl.retryAfter) : err("Unauthorized", 401);
    }
    if(op === "poll"){
      // One call: refresh presence, claim the oldest job, and learn whether to keep polling fast.
      const { job, busy } = await relay.poll({
        agentIp: validIPv4(body.ip) ? String(body.ip) : "",
        host: String(body.host || "").replace(/[^\w.-]/g, "").slice(0, 60),
        version: String(body.version || "").replace(/[^\w.-]/g, "").slice(0, 20),
      });
      if(job && job.type === "send"){
        const path = await signedDesignPath(env, job.fileKey);
        if(!path){
          await relay.putResult(job.id, { httpStatus: 500, body: { status: "error", message: "The site could not sign a download link for this design." } });
          return jsonResponse({ status: "ok", job: null, pollSeconds: HOT_POLL_SEC });
        }
        job.downloadUrl = url.origin + path;
        delete job.fileKey;
      }
      const fast = !!job || busy;
      return jsonResponse({ status: "ok", job: job || null, pollSeconds: fast ? HOT_POLL_SEC : IDLE_POLL_SEC });
    }
    // result
    const id = String(body.id || "");
    if(!ID_RE.test(id)) return err("Invalid job id.", 400);
    const json = JSON.stringify(body.body === undefined ? null : body.body);
    if(json.length > MAX_RESULT_BYTES) return err("Result too large.", 413);
    const httpStatus = Number.isInteger(body.httpStatus) && body.httpStatus >= 200 && body.httpStatus < 600 ? body.httpStatus : 502;
    await relay.putResult(id, { httpStatus, body: JSON.parse(json) });
    return jsonResponse({ status: "ok" });
  }

  // ---- Browser → site ----
  // Back office work: any signed-in user (functions/_lib/adminAuth.js).
  const denied = await requireAdmin(env, host, request.headers.get("X-Admin-Key"), request, "Not available here.", "staff");
  if(denied) return denied;
  // Global settings → Features → Production switched off: the admin can't queue machine jobs or ask
  // about the agent. (The agent's own polls above are left alone — they read no database, and with
  // nothing able to queue a job they simply find nothing.)
  if(await featureIsOff(env, "production")) return featureOffResponse("production", "Production");

  if(op === "status"){
    const p = await relay.status(!!body.hot);
    return jsonResponse({ status: "ok", online: !!p, lastSeenSec: p ? p.lastSeenSec : null, agentIp: p ? p.agentIp || "" : "" });
  }
  if(op === "submit"){
    const { job, error } = cleanJob(body);
    if(error) return err(error, 400);
    const bytes = crypto.getRandomValues(new Uint8Array(12));
    job.id = Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
    const placed = await relay.submit(job);   // "ok" | "offline" | "full" — presence check, enqueue and hot flag in one call
    if(placed === "offline") {
      return err("The send agent isn't online — check that it's running on the shop network.", 503, { code: "agent_offline" });
    }
    if(placed === "full") return err("Too many requests are waiting for the agent — try again in a moment.", 429);
    return jsonResponse({ status: "ok", id: job.id });
  }
  if(op === "result"){
    const id = String(body.id || "");
    if(!ID_RE.test(id)) return err("Invalid job id.", 400);
    const result = await relay.takeResult(id);
    return jsonResponse(result ? { status: "ok", done: true, result } : { status: "ok", done: false });
  }
  return err("Unknown operation.", 400);
}
