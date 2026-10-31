const fs = require("fs");
const { JSDOM, ResourceLoader } = require("jsdom");
const { createD1 } = require("./testlib/d1-shim.js");

// Blanks → Import from PDF, read with AI (functions/_lib/invoiceAi.js) when the layout reader in admin.js
// can't be trusted (pdfParseProblem_), or on the preview's "Read with AI" button:
//  - the server turns the model's JSON into the layout reader's own shape, and checks every number it
//    returns against the PDF's text, against qty × price, and against the printed subtotal — a failed check
//    is a warning, never a dropped line;
//  - a missing binding, the free plan's daily allowance, a model answer that isn't JSON, and an over-long
//    text each say what to do, in words;
//  - the 8 real invoice layouts (testlib/fixtures/pdf-order-items.json) still never reach the AI;
//  - the preview calls it only when it should, labels what it read, and falls back to the layout reader's
//    own answer when the AI can't help.
// Workers AI itself is a fake here (env.AI.run); real db.js / orders.js on sql.js for the server.
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const ai = new Function(strip(read("functions/_lib/invoiceAi.js")) + "\nreturn { readInvoiceWithAi, invoiceFromModel, INVOICE_AI_MODEL, INVOICE_AI_MAX_CHARS };")();
globalThis.__invoiceAi = ai;
const dbSrc = strip(read("functions/_lib/db.js"));
const api = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" +
  "const readInvoiceWithAi = (...a) => globalThis.__invoiceAi.readInvoiceWithAi(...a);\n" +
  "const requireAdmin = async (env, host, key, request, msg, role) => { const r = (request.headers.get('x-role') || 'admin'); const rank = { staff: 1, manager: 2, admin: 3 }; return rank[r] >= rank[role === 'staff' || role === 'manager' ? role : 'admin'] ? null : new Response(JSON.stringify({ status: 'error', code: 'forbidden' }), { status: 403 }); };\n" +
  "const adminActor = () => 'test'; const adminUser = () => null;\n" +
  "const rateLimited = async (env, bucket) => { (globalThis.__rl = globalThis.__rl || []).push(bucket); return { blocked: false }; }; const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: {}, orgs: {} });\n" +
  "const sendOrderReceivedEmail = async () => false, sendPaymentConfirmedEmail = async () => false, sendCancellationEmail = async () => false, sendDesignVerificationEmail = async () => false, sendShippingPaymentEmail = async () => false, sendShippedEmail = async () => false, sendInvoiceEmail = async () => false;\n" +
  "const ensureOrgDomain = async () => ({}), getOrgDomainStatus = async () => ({ configured: false });\n" +
  dbSrc + "\n" + strip(read("functions/api/orders.js")) + "\nreturn onRequestPost;")();
let pass = 0, fail = 0;
const ok = (d, c) => { console.log(d + ":", !!c); c ? pass++ : fail++; };
const items = JSON.parse(read("testlib/fixtures/pdf-order-items.json"));

// An emailed order confirmation, as pdfItemsToText_ lays it out (made-up values).
const TEXT = `--- page 1 ---
S&S Activewear | Order Confirmation
Order #: 920000001 | Placed 10/14/2026
Item | Product | Color | Size | Qty | Each | Ext.
B00760 | *Gildan - Heavy Cotton T-Shirt - 5000 | Navy | M | 4 | $3.12 | $12.48
B00761 | *Gildan - Heavy Cotton T-Shirt - 5000 | Navy | L | 6 | $3.12 | $18.72
C11220 | Richardson - Trucker Cap - 112 | Black | | 10 | $5.40 | $54.00
Merchandise Subtotal | $85.20
Freight | $9.95
Order Total | $95.15`;
const MODEL = { vendor: "S&S", vendorRef: "920000001", invoiceDate: "2026-10-14", shipping: 9.95, otherCharges: 0, subtotal: 85.2,
  lines: [{ sku: "B00760", description: "*Gildan - Heavy Cotton T-Shirt - 5000", color: "Navy", size: "M", qty: 4, unitCost: 3.12, lineTotal: 12.48 },
          { sku: "B00761", description: "Gildan - Heavy Cotton T-Shirt - 5000", color: "Navy", size: "L", qty: 6, unitCost: 3.12, lineTotal: 18.72 },
          { sku: "C11220", description: "Richardson - Trucker Cap - 112", color: "Black", size: "", qty: 10, unitCost: 5.4, lineTotal: 54 }] };
const clone = (o) => JSON.parse(JSON.stringify(o));
const fakeAi = (answer) => { const calls = []; return { calls, run: async (model, input) => { calls.push({ model, input }); if (answer instanceof Error) throw answer; return answer; } }; };
const errOf = async (p) => { try { await p; return null; } catch (e) { return e; } };

(async () => {
  console.log("=== The model's answer becomes the layout reader's own shape ===");
  let env = { AI: fakeAi({ response: clone(MODEL) }) };
  let r = await ai.readInvoiceWithAi(env, TEXT);
  ok("vendor, order #, date, and shipping + other charges read", r.vendor === "S&S" && r.vendorRef === "920000001" && r.receivedAt === "2026-10-14" && r.extraCost === 9.95 && r.source === "ai");
  ok("lines grouped by description + color, like the layout reader: two sizes of the tee are one candidate blank, the cap another", r.groups.length === 2 &&
    r.groups[0].lines.map(l => l.size + "×" + l.qty).join() === "M×4,L×6" && r.groups[1].lines[0].size === "" && r.groups[1].lines[0].lineTotal === 54);
  ok("the leading '*' (not returnable) is stripped, so the tee with and without it is one group", r.groups[0].description === "Gildan - Heavy Cotton T-Shirt - 5000");
  ok("every number is on the PDF and adds up: no warnings", r.warnings.length === 0);
  const call = env.AI.calls[0];
  ok("one call, to the model named in INVOICE_AI_MODEL, in JSON mode, with room for a long answer", env.AI.calls.length === 1 && call.model === ai.INVOICE_AI_MODEL &&
    call.input.response_format.type === "json_schema" && call.input.response_format.json_schema.properties.lines.type === "array" && call.input.max_tokens >= 4096);
  ok("…the PDF's text is what it's given", call.input.messages[1].role === "user" && call.input.messages[1].content === TEXT);

  console.log("\n=== A made-up or misread number is flagged, never dropped ===");
  let m = clone(MODEL); m.lines[2].lineTotal = 45; m.lines[2].unitCost = 4.5;
  r = ai.invoiceFromModel(m, TEXT);
  ok("a price and total that aren't printed anywhere on the PDF: a warning names the line, and the line is still there", r.groups[1].lines.length === 1 &&
    r.warnings.some(t => /Richardson - Trucker Cap - 112 Black: the price and total isn't printed/.test(t)));
  ok("…and the lines no longer add up to the printed subtotal: a second warning", r.warnings.some(t => /add up to \$76\.20, but the invoice's subtotal is \$85\.20/.test(t)));
  m = clone(MODEL); m.lines[0].qty = 6;
  r = ai.invoiceFromModel(m, TEXT);
  ok("numbers that are each on the PDF but don't multiply out (6 × $3.12 ≠ $12.48): a warning", r.warnings.some(t => /6 × \$3\.12 isn't \$12\.48/.test(t)));
  m = clone(MODEL); m.lines.push({ sku: "", description: "Total", color: "", size: "", qty: 0, unitCost: 0, lineTotal: 95.15 }); m.invoiceDate = "Oct 14";
  r = ai.invoiceFromModel(m, TEXT);
  ok("a line with no quantity isn't a line item; a date that isn't YYYY-MM-DD is left blank to be filled in", r.groups.length === 2 && r.receivedAt === "");
  m = clone(MODEL); m.lines[0].qty = "4"; m.lines[0].unitCost = "$3.12"; m.shipping = -5;
  r = ai.invoiceFromModel(m, TEXT);
  ok("numbers sent as text are read as numbers; a negative shipping figure counts as none", r.groups[0].lines[0].qty === 4 && r.groups[0].lines[0].unitCost === 3.12 && r.extraCost === 0 && r.warnings.length === 0);

  console.log("\n=== Answers in other shapes ===");
  r = await ai.readInvoiceWithAi({ AI: fakeAi({ response: "```json\n" + JSON.stringify(MODEL) + "\n```" }) }, TEXT);
  ok("JSON sent back as a string (even fenced) is read", r.groups.length === 2);
  r = await ai.readInvoiceWithAi({ AI: fakeAi({ choices: [{ message: { content: JSON.stringify(MODEL) } }] }) }, TEXT);
  ok("…and an OpenAI-style answer", r.groups.length === 2 && r.vendorRef === "920000001");

  console.log("\n=== Every failure says what to do ===");
  let e = await errOf(ai.readInvoiceWithAi({}, TEXT));
  ok("no AI binding: it isn't set up, enter the order by hand", e && e.userFacing && /isn't set up on this install/.test(e.message) && /Receive order/.test(e.message));
  const quiet = console.error; console.error = () => {};
  e = await errOf(ai.readInvoiceWithAi({ AI: fakeAi(new Error("4006: you have used up your daily free allocation of 10,000 neurons, please upgrade to Cloudflare's Workers Paid plan")) }, TEXT));
  ok("the free plan's 10,000 neurons used up: says so, and when it resets", e && e.userFacing && /free AI allowance is used up/.test(e.message) && /00:00 UTC/.test(e.message));
  e = await errOf(ai.readInvoiceWithAi({ AI: fakeAi(new Error("socket hang up")) }, TEXT));
  console.error = quiet;
  ok("any other failure reaching Workers AI: try again", e && e.userFacing && /Couldn't reach Cloudflare Workers AI/.test(e.message));
  e = await errOf(ai.readInvoiceWithAi({ AI: fakeAi({ response: "I'm sorry, I can't help with that." }) }, TEXT));
  ok("an answer that isn't the JSON asked for: couldn't read a table", e && e.userFacing && /couldn't read a line-item table/.test(e.message));
  let env2 = { AI: fakeAi({ response: clone(MODEL) }) };
  e = await errOf(ai.readInvoiceWithAi(env2, "x".repeat(ai.INVOICE_AI_MAX_CHARS + 1)));
  const e2 = await errOf(ai.readInvoiceWithAi(env2, "   "));
  ok("a text too long (it would be cut short) or empty (a scan) is refused before anything is spent", e && /too long/.test(e.message) && e2 && /may be a scan/.test(e2.message) && env2.AI.calls.length === 0);

  console.log("\n=== The orders endpoint ===");
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  const post = async (body, env, role = "staff") => { const res = await api({ env: Object.assign({ DB: d1 }, env), waitUntil: (p) => Promise.resolve(p).catch(() => {}),
      request: { url: "https://admin.example.com/api/orders", json: async () => Object.assign({ key: "x" }, body), headers: { get: (h) => h.toLowerCase() === "x-role" ? role : null } } });
    return { status: res.status, body: JSON.parse(await res.text()) }; };
  globalThis.__rl = [];
  let res = await post({ action: "readInvoiceWithAi", text: TEXT }, { AI: fakeAi({ response: clone(MODEL) }) });
  ok("staff (who receive stock) can use it, it's rate-limited, and it answers the preview's shape", res.status === 200 && res.body.status === "ok" && res.body.groups.length === 2 && res.body.source === "ai" && globalThis.__rl.includes("invoice_ai"));
  res = await post({ action: "readInvoiceWithAi", text: TEXT }, {});
  ok("…without the binding it's a 400 with the message, not a crash", res.status === 400 && res.body.status === "error" && /isn't set up/.test(res.body.message));
  ok("nothing is written: no stock received, no blank created", d1.q("SELECT count(*) n FROM blanks")[0].n === 0 && d1.q("SELECT count(*) n FROM inventory_movements")[0].n === 0);
  ok("wrangler.toml binds Workers AI as AI", /\n\[ai\]\nbinding = "AI"\n/.test(read("wrangler.toml")));

  console.log("\n=== In the admin: when the AI is asked ===");
  const adminJs = read("public/admin.js");
  class L extends ResourceLoader { fetch(url, o){ if (url.includes("/admin.js")) return Promise.resolve(Buffer.from(adminJs)); return super.fetch(url, o); } }
  const dom = new JSDOM(read("public/index.html"), { runScripts: "dangerously", resources: new L(), url: "https://admin.example.com/", pretendToBeVisual: true,
    beforeParse(win){ win.fetch = async () => ({ ok: true, status: 200, json: async () => ({ status: "error", message: "n/a" }) }); } });
  const w = dom.window, d = w.document;
  await new Promise(res => setTimeout(res, 150));
  await w.loadAdminScript();

  const problems = Object.keys(items).map(k => w.pdfParseProblem_(w.parseVendorOrderPdf_(items[k]), items[k]));
  ok("all 8 real S&S / SanMar layouts are read by the layout reader and add up to their own subtotal: none would go to the AI", problems.length === 8 && problems.every(p => p === ""));
  const ss1 = w.parseVendorOrderPdf_(items.ss1);
  const off = JSON.parse(JSON.stringify(ss1)); off.groups[0].lines[0].lineTotal += 10;
  ok("lines that don't add up to the printed subtotal would", /add up to \$414\.26, but the PDF's subtotal is \$404\.26/.test(w.pdfParseProblem_(off, items.ss1)));
  const noPrice = JSON.parse(JSON.stringify(ss1)); noPrice.groups[1].lines[0].unitCost = 0;
  ok("…and so would a line read with no price, or nothing found at all", /without a quantity, price or total/.test(w.pdfParseProblem_(noPrice, items.ss1)) &&
    /Could not find/.test(w.pdfParseProblem_(w.parseVendorOrderPdf_([{ str: "Thank you for your order", x: 10, y: 10, page: 1 }]), [])));
  const text = w.pdfItemsToText_(items.sm1);
  ok("the text sent keeps the table's columns apart (' | ') and marks each page", /Style \| Color \| Description \| Size \| Warehouse \| Pieces \| Price \| Amount/.test(text) &&
    /^--- page 1 ---\n/.test(text) && /\n--- page 2 ---\n/.test(text));
  ok("…and nothing in it is lost: every piece of text on the PDF is in it", items.sm1.every(it => text.includes(it.str.trim())));

  console.log("\n=== In the admin: the preview ===");
  const sent = [];
  let aiAnswer = null;
  w.__api = async (b) => { sent.push(b); if (b.action === "getBlanks") return { blanks: [] }; if (b.action === "readInvoiceWithAi") { if (aiAnswer instanceof Error) throw aiAnswer; return aiAnswer; } return {}; };
  w.eval("mnApi_ = (b) => window.__api(b); extractPdfItems_ = async () => window.__items; parseVendorOrderPdf_ = (it) => window.__parse(it);");
  const open = async () => {
    sent.length = 0; d.querySelectorAll(".admin-modal").forEach(n => n.remove());
    await w.showPdfImportModal_({ name: "order.pdf" }, () => {});
    for (let i = 0; i < 100 && !d.getElementById("piNext") && !/Could not|couldn't|isn't|No line/i.test(d.getElementById("pdfImpBody").textContent); i++) await new Promise(res => setTimeout(res, 10));
    return d.getElementById("pdfImpBody");
  };
  w.__items = items.ss1; w.__parse = (it) => ss1;
  let body = await open();
  ok("a PDF the layout reader handles: no AI call, and a 'Read with AI' button in case it's still wrong", !sent.some(b => b.action === "readInvoiceWithAi") && !!d.getElementById("piNext") && !!d.getElementById("piAi") && !/Read with AI —/.test(body.textContent));
  aiAnswer = await ai.readInvoiceWithAi({ AI: fakeAi({ response: clone(MODEL) }) }, TEXT);
  d.getElementById("piAi").click();
  for (let i = 0; i < 100 && !/Read with AI —/.test(body.textContent); i++) await new Promise(res => setTimeout(res, 10));
  ok("…pressing it sends the PDF's text and shows what the AI read, labelled to be checked", sent.filter(b => b.action === "readInvoiceWithAi").length === 1 &&
    sent.find(b => b.action === "readInvoiceWithAi").text === w.pdfItemsToText_(items.ss1) && /Read with AI — check every line/.test(body.textContent) &&
    d.querySelectorAll("[data-pi-row]").length === 2 && d.getElementById("piRef").value === "920000001" && !d.getElementById("piAi"));

  w.__parse = () => ({ vendor: "", vendorRef: "", receivedAt: "", extraCost: 0, groups: [], error: "Could not find a line-item table in this PDF." });
  const flagged = clone(MODEL); flagged.lines[2].lineTotal = 45;
  aiAnswer = ai.invoiceFromModel(flagged, TEXT);
  body = await open();
  ok("a PDF the layout reader can't read goes to the AI by itself, and its warnings are listed above the lines", sent.filter(b => b.action === "readInvoiceWithAi").length === 1 &&
    /Read with AI — check every line/.test(body.textContent) && /Richardson - Trucker Cap - 112 Black: the total isn't printed/.test(body.textContent) && !!d.getElementById("piNext"));

  aiAnswer = new Error("Today's free AI allowance is used up (it resets at 00:00 UTC). Try again tomorrow, or enter the order by hand with Receive order.");
  body = await open();
  ok("…when the AI can't help either, its reason is shown and nothing else is", /free AI allowance is used up/.test(body.textContent) && !d.getElementById("piNext"));

  w.__parse = () => off;
  w.__items = items.ss1;
  body = await open();
  ok("lines that don't add up go to the AI too — and when it can't help, the layout reader's lines are shown with both reasons", sent.some(b => b.action === "readInvoiceWithAi") &&
    !!d.getElementById("piNext") && /PDF's subtotal is \$404\.26/.test(body.textContent) && /Reading it with AI didn't work either: Today's free AI allowance/.test(body.textContent));

  console.log(`\n${fail ? "FAIL" : "ALL PASS"} — ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); console.log("test167 crashed: false"); process.exit(1); });
