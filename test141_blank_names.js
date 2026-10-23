const fs = require("fs");
const { createD1 } = require("./testlib/d1-shim.js");

// Blank names on stock movements (2026-10): each movement saved the blank's name when it was written, so a
// blank renamed later still showed its old name ("Sport Red Men's Zone Performance Polo") in the Inventory &
// COGS report and on receipts (Account viewer, Reconcile). The report now reads each blank's current name; renaming a blank
// renames its movements; migration 0066 brought the existing ones up to date. Real db.js on sql.js.
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const lib = new Function(strip(read("functions/_lib/db.js")) + `\nreturn { createBlank, updateBlank, getInventoryValuation, getTaxedResalePurchases, deleteBlank };`)();
let pass = 0, fail = 0;
const ok = (d, c) => { console.log(d + ":", !!c); c ? pass++ : fail++; };

(async () => {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  const id = (await lib.createBlank(d1, { name: "Sport Red Men's Zone Performance Polo", productType: "shirt", vendor: "S&S", sku: "TT51",
    colors: [{ color: "Sport Red", images: [], sizes: [{ size: "M", purchasePrice: 9, quantity: 3 }] }] })).id;
  const gone = (await lib.createBlank(d1, { name: "Old cap", productType: "cap", colors: [{ color: "Navy", images: [], sizes: [{ size: "OSFA", purchasePrice: 2, quantity: 1 }] }] })).id;
  const names = () => d1.q("SELECT DISTINCT blankName FROM inventory_movements WHERE blankId=?", id).map(r => r.blankName);

  await lib.updateBlank(d1, id, { name: "Team 365 TT51 Zone Performance Polo", productType: "shirt", vendor: "S&S", sku: "TT51" });
  ok("renaming a blank renames its stock movements", names().join() === "Team 365 TT51 Zone Performance Polo");

  // A movement still carrying an old name (written before this fix): the report reads the current name anyway.
  d1._raw.run(`UPDATE inventory_movements SET blankName = 'Sport Red Men''s Zone Performance Polo', vendorChargedTax = 1, kind = 'purchase' WHERE blankId = ${id}`);
  const v = await lib.getInventoryValuation(d1, "2999-01-01T00:00:00.000Z");
  ok("the Inventory & COGS report's stock lists the blank by its current name", v.rows.find(r => r.blankId === id).name === "Team 365 TT51 Zone Performance Polo");
  const taxed = await lib.getTaxedResalePurchases(d1, "2000-01-01", "2999-01-01");
  ok("…and so do its taxed purchases", taxed.length && taxed.every(t => t.blank === "Team 365 TT51 Zone Performance Polo"));

  // The data fix: bring stored names up to date; a deleted blank's movements keep theirs.
  await lib.deleteBlank(d1, gone);
  d1.execFile(read("migrations/0066_data_fix_movement_blank_names.sql"));
  ok("migration 0066 brings every movement of an existing blank to its current name", names().join() === "Team 365 TT51 Zone Performance Polo");
  ok("…and leaves a deleted blank's movements as they were", d1.q("SELECT blankName FROM inventory_movements WHERE blankId=?", gone)[0].blankName === "Old cap");
  ok("…and the report still names a deleted blank by its saved name", (await lib.getInventoryValuation(d1, "2999-01-01T00:00:00.000Z")).rows.find(r => r.blankId === gone).name === "Old cap");

  console.log(`\n${fail ? "FAIL" : "PASS"} — ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})().catch(e => { console.error(e); console.log("test130 crashed: false"); process.exit(1); });
