// Adopting an install made by an earlier copy of this code under another name:
//  * LEGACY_LABEL_PREFIX: its password marks, admin session cookie, shipping quotes, card-checkout tokens and draft
//    previews (signed "<name>-…" instead of "odd-…") keep working; each password is re-marked on first use; without
//    the setting they're refused as before;
//  * scripts/adopt-db.mjs: migrations applied under other numbers are matched by description, the SQL records this
//    repository's names only, and the undo removes exactly those;
//  * admin.js copies that copy's browser settings to the odd names once.
const fs = require("fs");
const crypto = require("crypto");
const { JSDOM } = require("jsdom");
const { makeAuth } = require("./testlib/auth-harness");

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
// The same module as the earlier copy had it: every "odd-" label under "old-".
const asOld = (src) => src.replace(/"odd-/g, "\"old-");
let pass = 0, fail = 0;
const ok = (d, c) => { console.log(d + ":", !!c); c ? pass++ : fail++; };

(async () => {
  // ---- the helper is the same in every file the tests paste together
  const helperOf = (f) => (/function legacyLabels_\(env, label\) \{[\s\S]*?\n\}/.exec(read(f)) || [""])[0];
  const files = ["functions/_lib/adminAuth.js", "functions/_lib/quoteToken.js", "functions/_lib/http.js", "functions/_lib/db.js"];
  ok("legacyLabels_ is identical in adminAuth, quoteToken, http and db", files.every(f => helperOf(f) && helperOf(f) === helperOf(files[0])));
  const legacyLabels_ = new Function(helperOf(files[0]) + "\nreturn legacyLabels_;")();
  ok("the prefix is letters and digits; odd itself, empty or anything else adds nothing",
    legacyLabels_({ LEGACY_LABEL_PREFIX: "old" }, "odd-x-v1:").join() === "odd-x-v1:,old-x-v1:" &&
    legacyLabels_({}, "odd-x").length === 1 && legacyLabels_({ LEGACY_LABEL_PREFIX: "odd" }, "odd-x").length === 1 &&
    legacyLabels_({ LEGACY_LABEL_PREFIX: "a-b" }, "odd-x").length === 1 && legacyLabels_({ LEGACY_LABEL_PREFIX: " OLD " }, "odd-x")[1] === "old-x");

  // ---- shipping quotes, card-checkout tokens, draft previews
  const SECRET = { SIGNING_SECRET: "s".repeat(40) };
  const quoteSrc = strip(read("functions/_lib/quoteToken.js")) + "\nreturn { signQuote, verifyQuote };";
  const nowQ = new Function(quoteSrc)(), oldQ = new Function(asOld(quoteSrc))();
  const oldQuote = await oldQ.signQuote(SECRET, { orgId: "acme", zip: "12345", items: "[]", amountCents: 900, method: "Ground" });
  ok("an earlier copy's shipping quote is refused without the setting", /Invalid/.test((await nowQ.verifyQuote(SECRET, oldQuote)).reason));
  ok("…and accepted with it", (await nowQ.verifyQuote({ ...SECRET, LEGACY_LABEL_PREFIX: "old" }, oldQuote)).ok);
  ok("a new quote still verifies with the setting on", (await nowQ.verifyQuote({ ...SECRET, LEGACY_LABEL_PREFIX: "old" }, await nowQ.signQuote(SECRET, { orgId: "acme", zip: "1", items: "[]", amountCents: 1, method: "x" }))).ok);

  const httpSrc = strip(read("functions/_lib/http.js")) + "\nreturn { signOrderToken, verifyOrderToken };";
  const nowH = new Function(httpSrc)(), oldH = new Function(asOld(httpSrc))();
  const oldTok = await oldH.signOrderToken(SECRET, "ORD-1");
  ok("a card-checkout token: refused without the setting, accepted with it, for that order only",
    !(await nowH.verifyOrderToken(SECRET, "ORD-1", oldTok)) && await nowH.verifyOrderToken({ ...SECRET, LEGACY_LABEL_PREFIX: "old" }, "ORD-1", oldTok) &&
    !(await nowH.verifyOrderToken({ ...SECRET, LEGACY_LABEL_PREFIX: "old" }, "ORD-2", oldTok)));

  const dbSrc = strip(read("functions/_lib/db.js")) + "\nreturn { signPreviewToken, verifyPreviewToken };";
  const nowD = new Function(dbSrc)(), oldD = new Function(asOld(dbSrc))();
  const oldPrev = await oldD.signPreviewToken(SECRET, "acme");
  ok("a draft preview link: refused without the setting, accepted with it",
    !(await nowD.verifyPreviewToken(SECRET, "acme", oldPrev)) && await nowD.verifyPreviewToken({ ...SECRET, LEGACY_LABEL_PREFIX: "old" }, "acme", oldPrev));

  // ---- passwords and the session cookie, through the real sign-in
  const A = await makeAuth();
  const cookie = await A.firstAdmin("Alex Sample", "alex@example.com", "a long password here");
  // Stage the earlier copy: the stored password and the install's mark made under "old-admin-password-v1".
  const oldMark = crypto.createHmac("sha256", A.env.PROXY_ADMIN_PASSPHRASE).update("old-admin-password-v1").digest("hex").slice(0, 16);
  const u = A.user("alex@example.com");
  const rec = JSON.parse(u.password); const newMark = rec.mark; rec.mark = oldMark;
  A.d1._raw.run("UPDATE users SET password=? WHERE id=?", [JSON.stringify(rec), u.id]);
  A.d1._raw.run("UPDATE global_settings SET value=? WHERE key='adminSecretMark'", [oldMark]);
  ok("staged: the stored password carries the earlier copy's mark", JSON.parse(A.user("alex@example.com").password).mark === oldMark && oldMark !== newMark);
  ok("without the setting the earlier copy's password doesn't sign in", (await A.signIn("alex@example.com", "a long password here")).status !== 200);
  A.env.LEGACY_LABEL_PREFIX = "old";
  const back = await A.signIn("alex@example.com", "a long password here");
  ok("with LEGACY_LABEL_PREFIX the same password signs in", back.status === 200 && !!back.cookie);
  ok("…and the record is re-marked under the odd- label (the hash unchanged)", JSON.parse(A.user("alex@example.com").password).mark === newMark &&
    JSON.parse(A.user("alex@example.com").password).hash === rec.hash);
  ok("…as is the install's own mark", A.d1.q("SELECT value FROM global_settings WHERE key='adminSecretMark'")[0].value === newMark);
  delete A.env.LEGACY_LABEL_PREFIX;
  ok("so it keeps working once the setting is removed", (await A.signIn("alex@example.com", "a long password here")).status === 200);
  ok("a wrong password is still refused with the setting on", (A.env.LEGACY_LABEL_PREFIX = "old", (await A.signIn("alex@example.com", "not the password!!")).status !== 200));

  // The session cookie the earlier copy set ("__Host-old_admin"): same session row (sessions are stored by hash).
  const asOldCookie = { headers: { cookie: "__Host-old_admin=" + back.cookie } };
  const listed = await A.orders({ action: "listOrgs" }, "", asOldCookie);
  ok("with the setting, the earlier copy's session cookie is still signed in", listed.status === 200);
  delete A.env.LEGACY_LABEL_PREFIX;
  ok("without it, that cookie is ignored", (await A.orders({ action: "listOrgs" }, "", asOldCookie)).status === 401);
  ok("our own cookie works either way", (await A.orders({ action: "listOrgs" }, cookie)).status === 200);

  // ---- scripts/adopt-db.mjs
  const S = await import("./scripts/adopt-db.mjs");
  const ours = fs.readdirSync(__dirname + "/migrations");
  // The earlier copy: this repository's migrations up to 0050, then the rest under other numbers, without our two
  // additions, plus a data fix of its own.
  const desc = (n) => n.replace(/^\d{4}_/, "");
  const extra = ours.filter(n => /^\d{4}_/.test(n) && Number(n.slice(0, 4)) > 50);
  const theirs = ours.filter(n => /^\d{4}_/.test(n) && Number(n.slice(0, 4)) <= 50)
    .concat(extra.slice(2).map((n, i) => String(51 + i).padStart(4, "0") + "_" + desc(n)), ["0090_data_fix_their_own.sql"]);
  const asJson = JSON.stringify([{ results: theirs.map(name => ({ name })), success: true }]);
  ok("reads the names from wrangler's --json answer and from plain lines", S.readAppliedNames("noise\n" + asJson).length === theirs.length &&
    S.readAppliedNames(theirs.join("\n")).length === theirs.length);
  const plan = S.planAdoption(S.readAppliedNames(asJson), ours);
  ok("everything from 0051 is matched by description to this repository's file", plan.matched.length === extra.length - 2 &&
    plan.matched.every(([old, mine]) => desc(old) === desc(mine) && old !== mine));
  ok("this repository's own two additions are left to npm run db:migrate", plan.pending.join() === extra.slice(0, 2).join());
  ok("the earlier copy's own data fix is listed, not touched", plan.unknown.join() === "0090_data_fix_their_own.sql");
  ok("names that already match aren't recorded again", plan.alreadyOurs.length === 50 && plan.problems.length === 0);
  const sql = S.adoptionSql(plan);
  ok("the SQL only inserts this repository's names (INSERT OR IGNORE), never deletes or renames",
    /INSERT OR IGNORE INTO d1_migrations/.test(sql) && !/DELETE|UPDATE/i.test(sql.replace(/^--.*$/gm, "")) && plan.matched.every(([, mine]) => sql.includes("'" + mine + "'")));
  const undo = S.undoSql(plan);
  ok("the undo deletes exactly those names", plan.matched.every(([, mine]) => undo.includes("'" + mine + "'")) && !theirs.some(n => undo.includes("'" + n + "'")));
  ok("a database with nothing recorded is refused (that's the other procedure)", S.planAdoption([], ours).problems.length === 1);
  ok("a description recorded twice under different numbers stops it",
    S.planAdoption(["0001_a.sql", "0002_a.sql"], ["0001_a.sql"]).problems.length === 1);
  let threw = false; try { S.adoptionSql(S.planAdoption([], ours)); } catch (e) { threw = true; }
  ok("…and no SQL is written for it", threw);

  // ---- browser settings
  const dom = new JSDOM("<!doctype html><body></body>", { url: "https://admin.example.com/", runScripts: "outside-only" });
  const w = dom.window, src = read("public/admin.js");
  w.localStorage.setItem("oldAdminSession", '{"token":"cookie","expires":"2999-01-01"}');
  w.localStorage.setItem("oldAdminEmail", "alex@example.com");
  w.localStorage.setItem("old_label_fonts_acme", '{"size":12}');
  w.localStorage.setItem("oldExpPaidFrom", "3");
  w.localStorage.setItem("oddAdminEmail", "already@example.com");
  w.eval(src.slice(src.indexOf("function adoptLegacyStorage_"), src.indexOf("adoptLegacyStorage_();")) + "\nadoptLegacyStorage_();");
  ok("the earlier copy's browser settings are copied to the odd names", w.localStorage.getItem("oddAdminSession") === '{"token":"cookie","expires":"2999-01-01"}' &&
    w.localStorage.getItem("odd_label_fonts_acme") === '{"size":12}' && w.localStorage.getItem("oddExpPaidFrom") === "3");
  ok("…never over a setting this page already has", w.localStorage.getItem("oddAdminEmail") === "already@example.com");

  ok("the docs explain both", /LEGACY_LABEL_PREFIX/.test(read("docs/configuration.md")) && /### A database from an earlier copy/.test(read("docs/operations.md")) &&
    /adopt-db\.mjs/.test(read("docs/operations.md")));

  console.log(`\n${fail ? "FAIL" : "ALL PASS"} — ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); console.log("crashed: false"); process.exit(1); });
