const fs = require("fs");
const path = require("path");

// The Worker entry point (src/worker.js): it must route
// /api/<name> to the same onRequest<Method> handlers with the same context shape, and its
// `scheduled` handler runs the daily roll-up only at the configured LOCAL hour.

(async () => {
  const w = await import("./src/worker.js");
  const sch = await import("./functions/_lib/schedule.js");
  const ctx = () => { const waits = []; return { waits, waitUntil: (p) => waits.push(p), passThroughOnException(){} }; };
  const req = (p, method = "GET") => new Request("https://admin.example.com" + p, { method });

  console.log("=== Every functions/api/*.js file is routed (none forgotten) ===");
  {
    const files = fs.readdirSync(path.join(__dirname, "functions/api")).filter(f => f.endsWith(".js")).map(f => f.replace(/\.js$/, "")).sort();
    console.log("ROUTES covers exactly the API files:", JSON.stringify(Object.keys(w.ROUTES).sort()) === JSON.stringify(files));
    console.log("every routed module exports a request handler:", Object.values(w.ROUTES).every(m => Object.keys(m).some(k => /^onRequest/.test(k))));
  }

  console.log("\n=== Routing ===");
  {
    let r = await w.handleRequest(req("/api/nope"), {}, ctx());
    console.log("unknown /api path → 404:", r.status === 404 && (await r.text()) === "Not found");
    r = await w.handleRequest(req("/api/admin-2fa", "GET"), {}, ctx());
    console.log("a method with no handler → 405:", r.status === 405);
    r = await w.handleRequest(req("/api/constructor"), {}, ctx());
    console.log("prototype keys are not routes:", r.status === 404);
    r = await w.handleRequest(req("/api/admin-session", "GET"), {}, ctx());
    const body = await r.json();
    console.log("GET /api/admin-session reaches the handler (its own 405 JSON):", r.status === 405 && body.status === "error");
    r = await w.handleRequest(req("/api/admin-session/", "GET"), {}, ctx());
    console.log("trailing slash routes the same:", r.status === 405);
    r = await w.handleRequest(req("/api/orders/extra"), {}, ctx());
    console.log("deeper paths are 404:", r.status === 404);
    r = await w.handleRequest(req("/index.html"), {}, ctx());
    console.log("non-API paths are 404 from the Worker (assets serve them first):", r.status === 404);
  }

  console.log("\n=== Handlers get the Pages-style context ===");
  {
    let seen = null;
    const original = w.ROUTES["image-proxy"].onRequestGet;
    // The module namespace is immutable, so route through a stand-in module for this check.
    const standIn = { onRequestGet: async (c) => { seen = c; return new Response("ok"); } };
    const saved = w.ROUTES["image-proxy"]; w.ROUTES["image-proxy"] = standIn;
    const c = ctx(); const env = { A: 1 };
    await w.handleRequest(req("/api/image-proxy?u=1"), env, c);
    w.ROUTES["image-proxy"] = saved;
    console.log("request, env, params, data are passed:", !!seen && seen.request.url.includes("image-proxy") && seen.env === env && typeof seen.params === "object" && typeof seen.data === "object");
    seen.waitUntil(Promise.resolve(1));
    console.log("waitUntil is wired to the Worker's execution context:", c.waits.length === 1);
    console.log("original handler untouched:", typeof original === "function");
    const head = { onRequestGet: async () => new Response("got") };
    w.ROUTES["image-proxy"] = head;
    const hr = await w.handleRequest(req("/api/image-proxy", "HEAD"), {}, ctx());
    w.ROUTES["image-proxy"] = saved;
    console.log("HEAD is served by the GET handler:", hr.status === 200);
  }

  console.log("\n=== Digest schedule: exactly one of the hourly UTC ticks runs, all year ===");
  {
    const env = { TIMEZONE: "America/Denver" }; // 6 AM in a zone with daylight saving
    const at = (iso) => sch.isDigestHour(env, new Date(iso));
    console.log("summer (daylight time): 12:00 UTC runs, 13:00 UTC doesn't:", at("2026-07-15T12:00:00Z") === true && at("2026-07-15T13:00:00Z") === false);
    console.log("winter (standard time): 13:00 UTC runs, 12:00 UTC doesn't:", at("2026-12-15T13:00:00Z") === true && at("2026-12-15T12:00:00Z") === false);
    console.log("spring-forward day (2026-03-08): 12:00 UTC is 6 AM daylight time:", at("2026-03-08T12:00:00Z") === true && at("2026-03-08T13:00:00Z") === false);
    console.log("fall-back day (2026-11-01): 13:00 UTC is 6 AM standard time:", at("2026-11-01T13:00:00Z") === true && at("2026-11-01T12:00:00Z") === false);
    // The cron fires every hour: for each zone, exactly one of a day's 24 ticks is the digest hour.
    const oncePerDay = (e, zone) => {
      for (let d = 0; d < 365; d++) {
        let n = 0;
        for (let h = 0; h < 24; h++) if (sch.isDigestHour(e, new Date(Date.UTC(2026, 0, 1 + d, h)), zone)) n++;
        if (n !== 1) return false;
      }
      return true;
    };
    console.log("across 365 days it runs exactly once per day:", oncePerDay(env));
    console.log("with nothing set the zone is UTC — 06:00 UTC, once a day:", sch.isDigestHour({}, new Date("2026-07-15T06:00:00Z")) === true
      && sch.isDigestHour({}, new Date("2026-07-15T10:00:00Z")) === false && oncePerDay({}));
    console.log("a zone passed in (the saved Region zone) wins over TIMEZONE:", sch.isDigestHour(env, new Date("2026-07-14T21:00:00Z"), "Asia/Tokyo") === true
      && sch.isDigestHour(env, new Date("2026-07-15T10:00:00Z"), "Asia/Tokyo") === false && oncePerDay(env, "Asia/Tokyo"));
    console.log("a half-hour zone still runs once a day:", oncePerDay({}, "Asia/Kolkata") && sch.isDigestHour({}, new Date("2026-07-15T00:00:00Z"), "Asia/Kolkata") === false
      && sch.isDigestHour({}, new Date("2026-07-15T01:00:00Z"), "Asia/Kolkata") === true);
    console.log("TIMEZONE/DIGEST_HOUR are honoured:", sch.isDigestHour({ TIMEZONE: "America/Los_Angeles", DIGEST_HOUR: "7" }, new Date("2026-07-15T14:00:00Z")) === true);
    console.log("a bad time zone falls back to UTC instead of never sending:", sch.isDigestHour({ TIMEZONE: "Not/AZone" }, new Date("2026-07-15T06:00:00Z")) === true);
    console.log("a bad hour falls back to 6:", sch.digestHour({ DIGEST_HOUR: "banana" }) === 6 && sch.digestHour({ DIGEST_HOUR: "25" }) === 6);
    console.log("the Worker is woken every hour:", /crons\s*=\s*\["0 \* \* \* \*"\]/.test(fs.readFileSync(path.join(__dirname, "wrangler.toml"), "utf8")));
  }

  console.log("\n=== scheduled(): skips off-hour ticks; records a failed run ===");
  {
    const off = await w.handleScheduled({ scheduledTime: Date.parse("2026-07-15T11:00:00Z") }, { TIMEZONE: "America/New_York" });
    console.log("an off-hour tick does nothing:", off.ran === false);
    const { makePlatformDb, platformGlobals } = require("./testlib/platform-db");
    const DB = await makePlatformDb();
    const res = await w.handleScheduled({ scheduledTime: Date.parse("2026-07-15T10:00:00Z") }, { DB, TIMEZONE: "America/New_York" }); // no secrets/orgs table → the roll-up can't complete
    const issue = DB.q("SELECT value FROM global_settings WHERE key='systemIssues'");
    console.log("an on-hour tick runs the roll-up:", res.ran === true);
    console.log("a roll-up that fails is recorded for the owner (digest_failed):", res.ok === false && issue.length === 1 && /digest_failed/.test(issue[0].value));
    const utc = await w.handleScheduled({ scheduledTime: Date.parse("2026-07-15T10:00:00Z") }, { DB });
    const utc6 = await w.handleScheduled({ scheduledTime: Date.parse("2026-07-15T06:00:00Z") }, { DB });
    console.log("with no time zone anywhere, 06:00 UTC is the tick:", utc.ran === false && utc6.ran === true);
    DB.q("INSERT OR REPLACE INTO global_settings (key, value) VALUES ('locale', '{\"timeZone\":\"Asia/Tokyo\",\"country\":\"US\"}')");
    const tky = await w.handleScheduled({ scheduledTime: Date.parse("2026-07-14T21:00:00Z") }, { DB, TIMEZONE: "America/New_York" });
    const notNy = await w.handleScheduled({ scheduledTime: Date.parse("2026-07-15T10:00:00Z") }, { DB, TIMEZONE: "America/New_York" });
    console.log("a time zone saved in Region beats TIMEZONE:", tky.ran === true && notNy.ran === false);
  }
})().catch((e) => { console.log("test84 crashed:", false); console.error(e); process.exit(1); });
