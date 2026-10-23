const fs = require("fs");
const { createD1 } = require("./testlib/d1-shim.js");

// Transfers history: voiding a movement is held to the same rules as blanks (closed months refuse it, the audit
// row is written first), and "Undo void" (restoreTransferMovement): the entry counts again, stock and average
// cost are recomputed from the whole history, it is audited first, refused in a closed month, and refused
// when restoring a write-off would take stock below zero. Real SQL, real db.js, real orders.js admin API.

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src
  .replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "")
  .replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const lib = new Function(dbSrc + `\nreturn { createTransfer, listTransfers, receiveTransferSheet, writeOffTransfers, getTransferMovements,
  voidTransferMovement, getTransferValuation };`)();
const api = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" +
  "const requireAdmin = async () => null; const adminActor = () => 'test';\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: {}, orgs: {} });\n" +
  "const sendOrderReceivedEmail = async () => false, sendOrderNotificationEmail = async () => false, sendPaymentConfirmedEmail = async () => false, sendCancellationEmail = async () => false, sendDesignVerificationEmail = async () => false, sendShippingPaymentEmail = async () => false;\n" +
  dbSrc + "\n" + strip(read("functions/api/orders.js")) + "\nreturn onRequestPost;")();

(async () => {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  const call = async (body) => {
    const res = await api({ env: { DB: d1 }, waitUntil: (p) => p.then(() => {}, () => {}),
      request: { url: "https://admin.example.com/api/orders", json: async () => Object.assign({ key: "x" }, body), headers: { get: () => null } } });
    return { status: res.status, body: JSON.parse(await res.text()) };
  };
  const stock = (id) => d1.q("SELECT quantity q, purchasePriceCents c FROM transfers WHERE id=?", id)[0];
  const mv = async (id, pred) => (await lib.getTransferMovements(d1, id)).find(pred);

  const t = await lib.createTransfer(d1, { name: "Lockup" });
  // Two receives at different costs: 10 @ $1.80 then 10 @ $2.20 → 20 @ $2.00.
  await lib.receiveTransferSheet(d1, { rows: [{ transferId: t, count: 10, pctOfSheet: 100 }], totalCents: 1800, receivedAt: "2026-07-01" });
  await lib.receiveTransferSheet(d1, { rows: [{ transferId: t, count: 10, pctOfSheet: 100 }], totalCents: 2200, receivedAt: "2026-07-05" });
  console.log("two receives: 20 on hand at $2.00 average:", stock(t).q === 20 && stock(t).c === 200);

  console.log("\n=== Undoing a void ===");
  const second = await mv(t, m => m.occurredAt.startsWith("2026-07-05"));
  await lib.voidTransferMovement(d1, second.id, "wrong sheet");
  console.log("voided: back to 10 @ $1.80:", stock(t).q === 10 && stock(t).c === 180);
  let r = await call({ action: "restoreTransferMovement", movementId: second.id });
  console.log("restore succeeds:", r.status === 200);
  console.log("stock and average cost are exactly what they were before the void (20 @ $2.00):", stock(t).q === 20 && stock(t).c === 200);
  const back = await mv(t, m => m.id === second.id);
  console.log("the row is no longer voided and its reason is cleared:", !back.voidedAt && !back.voidReason);
  console.log("the response carries refreshed history and transfers for the screen:", Array.isArray(r.body.movements) && Array.isArray(r.body.transfers));
  const aud = d1.q("SELECT detail FROM audit_log WHERE action='transfer.movement_restored'");
  const det = aud.length === 1 && JSON.parse(aud[0].detail);
  console.log("it is audited with what it was and why it had been voided:", !!det && det.movementId === second.id && det.wasVoidReason === "wrong sheet" && det.transferName === "Lockup" && det.qtyDelta === 10);
  console.log("it counts toward valuation again:", (await lib.getTransferValuation(d1, "2026-12-31T23:59:59Z")).units === 20);
  r = await call({ action: "restoreTransferMovement", movementId: second.id });
  console.log("restoring an entry that isn't voided is refused:", r.status === 400 && /isn't voided/.test(r.body.message));
  r = await call({ action: "restoreTransferMovement", movementId: 999999 });
  console.log("a bogus id is refused (404):", r.status === 404);
  r = await call({ action: "restoreTransferMovement", movementId: "abc" });
  console.log("a non-numeric id is refused (400):", r.status === 400);
  d1._raw.run("INSERT INTO transfer_movements (transferId, transferName, qtyDelta, unitCostCents, kind, occurredAt, createdAt, voidedAt, voidReason) VALUES (" + t + ", 'Lockup', -1, 200, 'consume', '2026-07-06T00:00:00Z', '2026-07-06T00:00:00Z', '2026-07-07T00:00:00Z', 'x')");
  const autoId = d1.q("SELECT max(id) i FROM transfer_movements")[0].i;
  r = await call({ action: "restoreTransferMovement", movementId: autoId });
  console.log("an automatic (order) entry is never restorable:", r.status === 409 && /generated automatically/.test(r.body.message));
  d1._raw.run("DELETE FROM transfer_movements WHERE id=" + autoId);

  console.log("\n=== A restore that would take stock below zero is refused ===");
  const w = await lib.createTransfer(d1, { name: "Capital" });
  await lib.receiveTransferSheet(d1, { rows: [{ transferId: w, count: 5, pctOfSheet: 100 }], totalCents: 1000, receivedAt: "2026-08-01" });
  await lib.writeOffTransfers(d1, { transferId: w, qty: 3, note: "Damaged", occurredAt: "2026-08-02" });
  const wo = await mv(w, m => m.kind === "writeoff");
  await lib.voidTransferMovement(d1, wo.id, "mistake");
  await lib.writeOffTransfers(d1, { transferId: w, qty: 4, note: "Lost", occurredAt: "2026-08-03" });
  console.log("setup: 1 left after the later write-off of 4:", stock(w).q === 1);
  r = await call({ action: "restoreTransferMovement", movementId: wo.id });
  console.log("restoring the 3-piece write-off would leave -2, so it is refused:", r.status === 409 && /only 1 is on hand/.test(r.body.message) && /below zero/.test(r.body.message));
  console.log("…and nothing changed (still voided, 1 on hand, no audit row for it):", stock(w).q === 1 && !!(await mv(w, m => m.id === wo.id)).voidedAt &&
    d1.q("SELECT count(*) n FROM audit_log WHERE action='transfer.movement_restored'")[0].n === 1);
  await lib.receiveTransferSheet(d1, { rows: [{ transferId: w, count: 4, pctOfSheet: 100 }], totalCents: 800, receivedAt: "2026-08-04" });
  r = await call({ action: "restoreTransferMovement", movementId: wo.id });
  console.log("once 5 are on hand the same restore works (2 left):", r.status === 200 && stock(w).q === 2);

  console.log("\n=== Closed months ===");
  const rec = await mv(w, m => m.occurredAt.startsWith("2026-08-04"));
  await lib.voidTransferMovement(d1, rec.id, "x");
  d1._raw.run("INSERT INTO closed_periods (month, closedAt, closedBy) VALUES ('2026-08','t','test')");
  r = await call({ action: "restoreTransferMovement", movementId: rec.id });
  console.log("restoring an entry dated in a closed month is refused:", r.status === 409 && /closed/i.test(r.body.message) && !!(await mv(w, m => m.id === rec.id)).voidedAt);
  d1._raw.run("DELETE FROM closed_periods");
  r = await call({ action: "restoreTransferMovement", movementId: rec.id });
  console.log("with the month reopened it works:", r.status === 200 && !(await mv(w, m => m.id === rec.id)).voidedAt);

  console.log("\n=== Voiding a transfer movement is held to the same rules (closed month, audit first) ===");
  const v = await lib.createTransfer(d1, { name: "Crest" });
  await lib.receiveTransferSheet(d1, { rows: [{ transferId: v, count: 6, pctOfSheet: 100 }], totalCents: 1200, receivedAt: "2026-09-01" });
  await lib.receiveTransferSheet(d1, { rows: [{ transferId: v, count: 4, pctOfSheet: 100 }], totalCents: 1000, receivedAt: "2026-10-01" });
  const sep = await mv(v, m => m.occurredAt.startsWith("2026-09-01")), oct = await mv(v, m => m.occurredAt.startsWith("2026-10-01"));
  console.log("setup: 10 on hand:", stock(v).q === 10);
  d1._raw.run("INSERT INTO closed_periods (month, closedAt, closedBy) VALUES ('2026-09','t','test')");
  r = await call({ action: "voidTransferMovement", movementId: sep.id, reason: "x" });
  console.log("voiding an entry dated in a closed month is refused (409):", r.status === 409 && /closed/i.test(r.body.message));
  console.log("…and nothing changed (not voided, still 10 on hand):", !(await mv(v, m => m.id === sep.id)).voidedAt && stock(v).q === 10);
  d1._raw.run("DELETE FROM closed_periods");

  d1._raw.run("ALTER TABLE audit_log RENAME TO audit_log_away");
  r = await call({ action: "voidTransferMovement", movementId: oct.id, reason: "x" });
  d1._raw.run("ALTER TABLE audit_log_away RENAME TO audit_log");
  console.log("if the audit row can't be written the void is refused (503) and nothing changes:", r.status === 503 && !(await mv(v, m => m.id === oct.id)).voidedAt && stock(v).q === 10);

  r = await call({ action: "voidTransferMovement", movementId: oct.id, reason: "wrong sheet" });
  console.log("a normal void works:", r.status === 200 && stock(v).q === 6);
  const vaud = JSON.parse(d1.q("SELECT detail FROM audit_log WHERE action='transfer.movement_voided' ORDER BY id DESC LIMIT 1")[0].detail);
  console.log("it is audited with the reason and what the entry was:", vaud.reason === "wrong sheet" && vaud.movementId === oct.id && vaud.transferName === "Crest" &&
    vaud.before.qtyDelta === 4 && vaud.before.kind === "purchase" && vaud.before.transferId === v);
  r = await call({ action: "voidTransferMovement", movementId: oct.id, reason: "again" });
  console.log("voiding it again is refused:", r.status === 400 && /already voided/.test(r.body.message));
  r = await call({ action: "voidTransferMovement", movementId: 999999, reason: "x" });
  console.log("a bogus id is refused (404):", r.status === 404);
  r = await call({ action: "voidTransferMovement", movementId: "abc", reason: "x" });
  console.log("a non-numeric id is refused (400):", r.status === 400);
  d1._raw.run("INSERT INTO transfer_movements (transferId, transferName, qtyDelta, unitCostCents, kind, occurredAt, createdAt) VALUES (" + v + ", 'Crest', -1, 200, 'consume', '2026-10-02T00:00:00Z', '2026-10-02T00:00:00Z')");
  const autoId2 = d1.q("SELECT max(id) i FROM transfer_movements")[0].i;
  r = await call({ action: "voidTransferMovement", movementId: autoId2, reason: "x" });
  console.log("an automatic (order) entry can't be voided here:", r.status === 400 && /generated automatically/.test(r.body.message));
  r = await call({ action: "voidTransferMovement", movementId: sep.id });
  console.log("a missing reason defaults rather than failing the void:", r.status === 200 && (await mv(v, m => m.id === sep.id)).voidReason === "Entered by mistake");

  console.log("\n=== The screen ===");
  const adminSrc = read("public/admin.js"), ordersSrc = read("functions/api/orders.js");
  console.log("Transfers History shows 'Undo void' on voided, voidable entries and still 'Void' on live ones:",
    /transferRestore_/.test(adminSrc) && /m\.voidedAt && \["purchase", "adjust", "writeoff"\]/.test(adminSrc) && /!m\.voidedAt && \["purchase", "adjust", "writeoff"\]/.test(adminSrc));
  console.log("it confirms first and calls the new action:", /Undo this void\?/.test(adminSrc) && /action: "restoreTransferMovement"/.test(adminSrc));
  console.log("the action is admin-only and period-guarded:", /"voidTransferMovement", "restoreTransferMovement"/.test(ordersSrc) && /a === "voidTransferMovement" \|\| a === "restoreTransferMovement"/.test(ordersSrc));
  console.log("the Audit Log has readable labels:", /"transfer\.movement_restored":\s+"Transfer entry restored/.test(adminSrc) && /"transfer\.movement_voided":\s+"Transfer entry voided"/.test(adminSrc));
})().catch((e) => { console.log("test87 crashed:", false); console.error(e); process.exit(1); });
