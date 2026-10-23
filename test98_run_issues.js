const fs = require("fs");
const { createD1 } = require("./testlib/d1-shim.js");
const { JSDOM, ResourceLoader } = require("jsdom");

// Finishing a timed run (migrations/0046): the prompt on Run Order — run time, the design's average
// on that machine, a tick box and a count per kind of issue, a note for "Other" — what's saved on the
// run, and the Run Times report's issue columns and "Other issue details" list.
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const lib = new Function(dbSrc + `\nreturn { insertOrder, createHoop, createThread, saveDesign, addDesignVersion, setProductDesign, createProduct, saveMachine,
  cleanRunIssues, runIssuesText, RUN_ISSUE_KINDS, getRunStats, getRunReportByDesign, completeProductionRun };`)();
const api = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" +
  "const requireAdmin = async () => null; const adminActor = () => 'test';\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: {}, orgs: {} });\n" +
  "const sendOrderReceivedEmail = async () => false, sendPaymentConfirmedEmail = async () => false, sendCancellationEmail = async () => false, sendDesignVerificationEmail = async () => false, sendShippingPaymentEmail = async () => false, sendShippedEmail = async () => false;\n" +
  "const ensureOrgDomain = async () => ({}), getOrgDomainStatus = async () => ({});\n" +
  dbSrc + "\n" + strip(read("functions/api/orders.js")) + "\nreturn onRequestPost;")();

let pass = 0, fail = 0;
const ok = (d, c) => { console.log(d + ":", !!c); c ? pass++ : fail++; };

(async () => {
  console.log("=== The issue list and its tidying ===");
  ok("six kinds, in the order asked for", lib.RUN_ISSUE_KINDS.map(k => k.label).join("|") === "Thread break|Bobbin ran out|Bird's nest|Needle break|Needle replaced|Other");
  let c = lib.cleanRunIssues({ threadBreak: 3, bobbinOut: 1, birdsNest: 0, needleBreak: "2", needleReplaced: -1, laser: 4, other: 1 }, "  hoop  slipped ");
  ok("counts of 1 or more are kept, zero / negative / unknown kinds dropped", JSON.stringify(c.issues) === JSON.stringify({ threadBreak: 3, bobbinOut: 1, needleBreak: 2, other: 1 }) && c.note === "hoop slipped");
  ok("a count is capped at 99 and fractions are whole", lib.cleanRunIssues({ threadBreak: 500, bobbinOut: 2.9 }).issues.threadBreak === 99 && lib.cleanRunIssues({ bobbinOut: 2.9 }).issues.bobbinOut === 2);
  ok("a note typed without ticking Other still counts as one Other", lib.cleanRunIssues({}, "odd noise").issues.other === 1);
  ok("nothing ticked = a clean run", JSON.stringify(lib.cleanRunIssues(null, "")) === JSON.stringify({ issues: {}, note: "" }));
  ok("one-line summary", lib.runIssuesText({ threadBreak: 3, bobbinOut: 1 }) === "Thread break ×3, Bobbin ran out");

  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt, ready) VALUES ('prime','prime','Example League','t','t',1);`);
  const hoop = await lib.createHoop(d1, { name: "6.9in", isCapFrame: false });
  const thread = await lib.createThread(d1, { brand: "Madeira", type: "PolyNeon", weight: "40", code: "1", name: "Red", colorHex: "cc0000" });
  const design = await lib.saveDesign(d1, "prime", { name: "Left chest crest", hoopIds: [hoop] });
  await lib.addDesignVersion(d1, design, { designFileKey: "d/a.emb", designFileName: "a.emb", machineFileKey: "d/a.dst", machineFileName: "A.DST", machineFileExt: "dst", threadColors: [{ needle: 1, threadId: thread }] });
  await lib.createProduct(d1, "prime", { productId: "shirt", type: "shirt", name: "Polo", pricingMode: "sized", sizePricing: { L: 25 }, visible: true });
  await lib.setProductDesign(d1, "prime", "shirt", design);
  const m1 = await lib.saveMachine(d1, { name: "Machine 1", needleCount: 12, hoopIds: [hoop] });
  const m2 = await lib.saveMachine(d1, { name: "Machine 2", needleCount: 15, hoopIds: [hoop] });
  const order = async (id, qty = 1) => {
    await lib.insertOrder(d1, { orderId: id, orgId: "prime", customerName: "C " + id, contact: "c@x.com", placedAt: "2026-09-01T00:00:00Z" }, [{ productId: "shirt", name: "Polo", type: "shirt", size: "L", qty, unitPrice: 25 }]);
    for (const [col, v] of Object.entries({ paid: 1, blankReceivedAt: "2026-09-03", designApprovedAt: "2026-09-04", digitizingCompleteAt: "2026-09-03" })) d1._raw.run(`UPDATE orders SET ${col}=? WHERE orderId=?`, [v, id]);
    return Number(d1.q(`SELECT id FROM order_items WHERE orderId='${id}'`)[0].id);
  };
  const call = async (body) => {
    const res = await api({ env: { DB: d1 }, waitUntil: (p) => p.then(() => {}, () => {}), request: { url: "https://admin.example.com/api/orders", json: async () => Object.assign({ key: "x" }, body), headers: { get: () => null } } });
    return { status: res.status, body: JSON.parse(await res.text()) };
  };
  // Starts a run on a machine and backdates its start so the run has a known length when finished.
  const run = async (orderId, machineId, minutesAgo) => {
    const itemId = await order(orderId);
    const r = await call({ action: "startRun", org: "prime", orderId, itemId, machineId });
    if (r.status !== 200) throw new Error("startRun failed: " + JSON.stringify(r.body));
    const runId = Number(d1.q(`SELECT id FROM production_runs WHERE orderId='${orderId}' ORDER BY id DESC`)[0].id);
    d1._raw.run("UPDATE production_runs SET startedAt=? WHERE id=?", [new Date(Date.now() - minutesAgo * 60000).toISOString(), runId]);
    return runId;
  };
  const row = (id) => d1.q(`SELECT status, startedAt, finishedAt, issuesJson, issueNote FROM production_runs WHERE id=${id}`)[0];

  console.log("\n=== Averages shown before finishing ===");
  const r1 = await run("A1", m1, 10);
  let st = (await call({ action: "getRunStats", runId: r1 })).body;
  ok("the first timed run of a design has no average yet", st.stats.onMachine.runs === 0 && st.stats.allMachines.runs === 0 && st.stats.designName === "Left chest crest" && st.stats.machineName === "Machine 1" && st.issueKinds.length === 6);
  ok("an unknown run is a 404", (await call({ action: "getRunStats", runId: 9999 })).status === 404);

  console.log("\n=== Finishing with issues ===");
  let f = await call({ action: "completeRun", runId: r1, org: "prime", orderId: "A1", issues: { threadBreak: 3, bobbinOut: 1, bogus: 9 }, issueNote: "" });
  ok("the run is finished with its issues and counts saved", f.status === 200 && row(r1).status === "done" && row(r1).issuesJson === JSON.stringify({ threadBreak: 3, bobbinOut: 1 }) && row(r1).issueNote === "");
  await new Promise(res => setTimeout(res, 20));
  ok("the issues are in the audit log", /"issues":\{"threadBreak":3,"bobbinOut":1\}/.test(d1.q("SELECT detail FROM audit_log WHERE action='run.completed' ORDER BY id DESC")[0].detail));
  const r2 = await run("A2", m1, 20);
  const pressed = new Date(Date.now() - 4 * 60000).toISOString();          // pressed Mark done 4 minutes ago, answered the prompt just now
  f = await call({ action: "completeRun", runId: r2, org: "prime", orderId: "A2", issues: { other: 2 }, issueNote: "Hoop slipped; re-hooped", finishedAt: pressed });
  ok("the clock stops when the button was pressed, not when the prompt was answered (16 min, not 20)", row(r2).finishedAt === pressed && Math.round((Date.parse(row(r2).finishedAt) - Date.parse(row(r2).startedAt)) / 60000) === 16);
  ok("Other is saved with its count and its note", row(r2).issuesJson === JSON.stringify({ other: 2 }) && row(r2).issueNote === "Hoop slipped; re-hooped");
  const r3 = await run("A3", m2, 30);
  f = await call({ action: "completeRun", runId: r3, org: "prime", orderId: "A3", finishedAt: "2099-01-01T00:00:00Z" });
  ok("a finish time in the future is ignored (now is used); a clean run saves no issues", Math.abs(Date.parse(row(r3).finishedAt) - Date.now()) < 5000 && row(r3).issuesJson === "{}");
  const r4 = await run("A4", m2, 5);
  f = await call({ action: "completeRun", runId: r4, org: "prime", orderId: "A4", finishedAt: "2000-01-01T00:00:00Z", issues: { needleBreak: 1, needleReplaced: 1, birdsNest: 2 } });
  ok("a finish time before the start is ignored too", Date.parse(row(r4).finishedAt) >= Date.parse(row(r4).startedAt));
  ok("finishing a run twice is refused and doesn't overwrite its issues", (await call({ action: "completeRun", runId: r1, org: "prime", orderId: "A1", issues: { other: 5 }, issueNote: "x" })).status === 400 && row(r1).issuesJson === JSON.stringify({ threadBreak: 3, bobbinOut: 1 }));

  const r5 = await run("A5", m1, 1);
  st = (await call({ action: "getRunStats", runId: r5 })).body.stats;
  ok("the average is for this design on THIS machine (10 and 16 min → 13 min over 2 runs)", st.onMachine.runs === 2 && Math.round(st.onMachine.avgMs / 60000) === 13);
  ok("…and across every machine (10, 16, 30, 5 → 4 runs)", st.allMachines.runs === 4 && Math.round(st.allMachines.avgMs / 60000) === 15);
  ok("the running job itself isn't in its own average", st.status === "running");

  console.log("\n=== Run Times report ===");
  const today = new Date().toISOString().slice(0, 10);
  const rep = (await call({ action: "getRunReportByDesign", from: "2020-01-01", to: today })).body.report;
  const d = rep.designs[0], byM = (n) => d.byMachine.find(m => m.machineName === n);
  ok("each design totals every kind of issue over its runs", JSON.stringify(d.issues) === JSON.stringify({ threadBreak: 3, bobbinOut: 1, other: 2, birdsNest: 2, needleBreak: 1, needleReplaced: 1 }) && d.runs === 4 && d.runsWithIssues === 3);
  ok("…and per machine", JSON.stringify(byM("Machine 1").issues) === JSON.stringify({ threadBreak: 3, bobbinOut: 1, other: 2 }) && byM("Machine 1").runsWithIssues === 2 &&
    JSON.stringify(byM("Machine 2").issues) === JSON.stringify({ birdsNest: 2, needleBreak: 1, needleReplaced: 1 }) && byM("Machine 2").runsWithIssues === 1);
  ok("totals for the whole range", rep.issueTotals.threadBreak === 3 && rep.issueTotals.other === 2 && rep.runsWithIssues === 3 && rep.doneRuns === 4 && rep.issueKinds.length === 6);
  ok("each run in the log carries its own issues", rep.detail.find(x => x.orderId === "A1").issues.threadBreak === 3 && Object.keys(rep.detail.find(x => x.orderId === "A3").issues).length === 0 && Object.keys(rep.detail.find(x => x.orderId === "A5").issues).length === 0);
  ok("the Other details list has the note, its count, and where it happened", rep.otherNotes.length === 1 && rep.otherNotes[0].note === "Hoop slipped; re-hooped" && rep.otherNotes[0].count === 2 &&
    rep.otherNotes[0].machineName === "Machine 1" && rep.otherNotes[0].orderId === "A2" && rep.otherNotes[0].designName === "Left chest crest");

  // ---- The screens ----
  const html = read("public/index.html"), adminJs = read("public/admin.js");
  class L extends ResourceLoader { fetch(url, o){ if (url.includes("/admin.js")) return Promise.resolve(Buffer.from(adminJs)); return super.fetch(url, o); } }
  const sent = [];
  const dom = new JSDOM(html, { runScripts: "dangerously", resources: new L(), url: "https://admin.example.com/", pretendToBeVisual: true,
    beforeParse(win){ win.fetch = async (url, init) => {
      if (String(url).includes("/api/orders")) { const b = JSON.parse(init.body); sent.push(b); const r = await call(b); return { ok: r.status < 400, status: r.status, json: async () => r.body }; }
      return { ok: true, status: 200, json: async () => ({ status: "admin" }) }; }; } });
  const w = dom.window, doc = w.document;
  await new Promise(r => setTimeout(r, 150));
  await w.loadAdminScript();
  w.eval(`adminKey = "cookie";`);
  const q = (s) => doc.querySelector(s);
  const until = async (fn) => { for (let i = 0; i < 200 && !fn(); i++) await new Promise(r => setTimeout(r, 10)); return !!fn(); };

  console.log("\n=== The finish prompt ===");
  ok("Mark done on a timed job opens the prompt instead of finishing straight away", /\.run-complete-btn"\)\.forEach\(btn => btn\.onclick = \(\) => \{[\s\S]{0,200}showRunFinishModal_\(/.test(adminJs) && !/run-btn"\)\.forEach[\s\S]{0,900}showRunFinishModal_/.test(adminJs.slice(adminJs.indexOf('body.querySelectorAll(".run-btn")'), adminJs.indexOf('body.querySelectorAll(".run-start-btn")'))));
  let done = null;
  const pressedAt = new Date().toISOString();
  w.showRunFinishModal_({ runId: r5, orgId: "prime", orderId: "A5", pressedAt, doneLabel: "Mark piece done", onDone: (r) => { done = r; } });
  await until(() => q("#rfDone"));
  ok("the top shows this run's time", /^Run time: 1m \ds$|^Run time: \d+s$|^Run time: 1m \d\ds$/.test(q("#rfTimes").textContent.replace(/\s+/g, " ").match(/Run time: [^A]+?s/)[0].trim()));
  ok("…and the design's average on that machine, with how this run compares", /Average for this design on Machine 1: 13m 0s over 2 runs/.test(q("#rfAvg").textContent) && /faster/.test(q("#rfAvg").textContent));
  const rows = () => [...doc.querySelectorAll(".rf-row")];
  const rowOf = (key) => rows().find(r => r.dataset.key === key);
  ok("a tick box for each issue, in order, none ticked", rows().map(r => r.textContent.replace(/[−+]/g, "").trim()).join("|") === "Thread break|Bobbin ran out|Bird's nest|Needle break|Needle replaced|Other" && rows().every(r => !r.querySelector(".rf-on").checked));
  ok("the count is hidden until its box is ticked", rows().every(r => r.querySelector(".rf-count").style.visibility === "hidden"));
  const tick = (key, on = true) => { const b = rowOf(key).querySelector(".rf-on"); b.checked = on; b.dispatchEvent(new w.Event("change")); };
  tick("threadBreak");
  ok("ticking shows the count, starting at 1", rowOf("threadBreak").querySelector(".rf-count").style.visibility === "visible" && rowOf("threadBreak").querySelector(".rf-n").value === "1");
  rowOf("threadBreak").querySelector(".rf-plus").click(); rowOf("threadBreak").querySelector(".rf-plus").click();
  ok("+ raises it (3 thread breaks)", rowOf("threadBreak").querySelector(".rf-n").value === "3");
  rowOf("threadBreak").querySelector(".rf-minus").click(); rowOf("threadBreak").querySelector(".rf-minus").click(); rowOf("threadBreak").querySelector(".rf-minus").click();
  ok("− never takes it below 1", rowOf("threadBreak").querySelector(".rf-n").value === "1");
  const n = rowOf("threadBreak").querySelector(".rf-n"); n.value = "0"; n.dispatchEvent(new w.Event("change"));
  ok("typing 0 (or less) goes back to 1", n.value === "1");
  n.value = "3"; n.dispatchEvent(new w.Event("change"));
  tick("threadBreak", false); tick("threadBreak");
  ok("unticking and ticking again starts the count at 1 again", n.value === "1");
  n.value = "3"; n.dispatchEvent(new w.Event("change"));
  tick("needleReplaced");
  ok("the Other box is hidden until Other is ticked", q("#rfNoteWrap").style.display === "none");
  tick("other");
  ok("ticking Other shows the free-form box", q("#rfNoteWrap").style.display === "");
  q("#rfDone").click();
  await new Promise(r => setTimeout(r, 30));
  ok("Other without a description is refused, and the job is still running", /Say what the other issue was/.test(q("#rfErr").textContent) && row(r5).status === "running" && !done);
  q("#rfNote").value = "Thread cone ran out mid-design";
  ok("the button keeps the job's own wording", q("#rfDone").textContent === "Mark piece done");
  q("#rfDone").click();
  await until(() => done);
  ok("Mark done finishes the run with what was ticked, each with its count", row(r5).status === "done" && row(r5).issuesJson === JSON.stringify({ threadBreak: 3, needleReplaced: 1, other: 1 }) && row(r5).issueNote === "Thread cone ran out mid-design" && !q("#rfDone"));
  ok("…stamped with when the button was pressed", row(r5).finishedAt === pressedAt);

  const r6 = await run("A6", m2, 2);
  done = null;
  w.showRunFinishModal_({ runId: r6, orgId: "prime", orderId: "A6", pressedAt: new Date().toISOString(), onDone: (r) => { done = r; } });
  await until(() => q("#rfDone"));
  q("#rfCancel").click();
  ok("Cancel closes the prompt and leaves the job running", !q("#rfDone") && row(r6).status === "running");
  w.showRunFinishModal_({ runId: r6, orgId: "prime", orderId: "A6", pressedAt: new Date().toISOString(), onDone: (r) => { done = r; } });
  await until(() => q("#rfDone"));
  q("#rfDone").click();
  await until(() => done);
  ok("with nothing ticked the run is finished clean", row(r6).status === "done" && row(r6).issuesJson === "{}" && row(r6).issueNote === "");

  console.log("\n=== The report screen ===");
  await w.renderRunReport(doc.getElementById("app"));
  await until(() => q("#rrIssueSummary"));
  const text = (el) => el.textContent.replace(/\s+/g, " ").trim();
  ok("a summary of the issues in the range", /Issues in this range \(4 of 6 finished runs had one\)/.test(text(q("#rrIssueSummary"))) && /Thread break 6/.test(text(q("#rrIssueSummary"))) && /Other 3/.test(text(q("#rrIssueSummary"))));
  const table = q("#rrResults table");
  const heads = [...table.querySelectorAll("thead th")].map(t => t.textContent);
  ok("each design's table has a column per issue", heads.slice(1, 11).join("|") === "Completed|Avg|Total|Aborted|Thread brk|Bobbin|Bird's nest|Needle brk|Needle repl|Other");
  const cells = (tr) => [...tr.querySelectorAll("td")].map(td => td.textContent.trim());
  const body = [...table.querySelectorAll("tbody tr")].map(cells);
  ok("All machines row totals them", body[0][0] === "All machines" && body[0].slice(5, 11).join("|") === "6|1|2|1|2|3");
  ok("each machine has its own counts", body.find(r => r[0] === "Machine 1").slice(5, 11).join("|") === "6|1|0|0|1|3" && body.find(r => r[0] === "Machine 2").slice(5, 11).join("|") === "0|0|2|1|1|0");
  const logRow = [...doc.querySelectorAll("#rrResults tr")].map(tr => text(tr)).find(t => /A5/.test(t));
  ok("the run log lists each run's issues", /Thread break ×3, Needle replaced, Other/.test(logRow));
  const notes = [...q("#rrOtherNotes").querySelectorAll("tbody tr")].map(tr => text(tr));
  ok("the Other issue details list is at the bottom, with each note and where it happened", notes.length === 2 && notes.some(t => /Machine 1/.test(t) && /A5/.test(t) && /Thread cone ran out mid-design/.test(t)) && notes.some(t => /×2 Hoop slipped; re-hooped/.test(t)) &&
    adminJs.indexOf("Other issue details") > adminJs.indexOf(">Run log<"));

  console.log(`\n${fail ? "FAIL" : "ALL PASS"} — ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); console.log("crashed: false"); process.exit(1); });
