// Blanks → Import from PDF, read by a model (Cloudflare Workers AI) — for a vendor PDF the layout reader
// in admin.js (parseVendorOrderPdf_) can't make sense of: a slightly different layout, an emailed order
// confirmation, a vendor not seen before. The browser still reads the PDF itself (pdf.js) and sends only
// its text, laid out in lines with column gaps (admin.js pdfItemsToText_); the model turns that into the
// same {vendor, vendorRef, receivedAt, extraCost, groups} the layout reader returns, so the preview and
// Receive order screens work unchanged. Nothing is saved here: the admin checks every line before Save.
//
// A model can misread or make up a number, so every qty / price / total it returns is checked against
// the text it was given and against each other (qty × price = line total; the lines add up to the
// printed subtotal). A failed check is a warning shown with the preview — the line is never dropped.
//
// Cost: one call per PDF, roughly 150–350 neurons for a 1–2 page invoice on the model below (Workers
// Free: 10,000 a day included; Workers Paid: $0.011 per 1,000 after that). See docs/configuration.md.

export const INVOICE_AI_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
// About ten pages of invoice text; anything longer is refused rather than cut (a cut table would read as
// a smaller order).
export const INVOICE_AI_MAX_CHARS = 40000;

const userError_ = (message) => Object.assign(new Error(message), { userFacing: true });

const SYSTEM_PROMPT = `You read the text of a garment supplier's invoice or order confirmation (S&S Activewear, SanMar, or another blank-apparel vendor) and return its line items as JSON.
The text was taken from a PDF: one printed line per line, with " | " where there was a wide gap between columns. A table row's cells can wrap onto the line above or below it.
Rules:
- One entry in "lines" per line item (one size of one product in one color). Never invent a line, and skip subtotal, tax, shipping and total rows.
- Copy every number exactly as printed. qty is the quantity shipped/invoiced (if both "ordered" and "shipped" are printed, use shipped); unitCost is the price of one piece; lineTotal is that line's amount.
- sku is the item / style number; description is the product's name as printed (without a leading "*", which is only a "not returnable" mark); color and size as printed ("" when there is none, e.g. a one-size cap).
- vendor: "S&S" for S&S Activewear, "SanMar" for SanMar, otherwise the supplier's name as printed.
- vendorRef: the invoice or order number. For SanMar use the sales order number (starts "SO-") rather than the INV- invoice number.
- invoiceDate: the invoice or order date as YYYY-MM-DD ("" if none).
- shipping: shipping / freight / handling charged (the first such figure only — invoices sometimes repeat it in a recap box); otherCharges: any other added fee such as a card surcharge; subtotal: the printed merchandise subtotal. Use 0 for any that aren't printed.`;

const LINE_SCHEMA = {
  type: "object",
  properties: {
    sku: { type: "string" }, description: { type: "string" }, color: { type: "string" }, size: { type: "string" },
    qty: { type: "number" }, unitCost: { type: "number" }, lineTotal: { type: "number" },
  },
  required: ["sku", "description", "color", "size", "qty", "unitCost", "lineTotal"],
};
const INVOICE_SCHEMA = {
  type: "object",
  properties: {
    vendor: { type: "string" }, vendorRef: { type: "string" }, invoiceDate: { type: "string" },
    shipping: { type: "number" }, otherCharges: { type: "number" }, subtotal: { type: "number" },
    lines: { type: "array", items: LINE_SCHEMA },
  },
  required: ["vendor", "vendorRef", "invoiceDate", "shipping", "otherCharges", "subtotal", "lines"],
};

const cents_ = (n) => Math.round(Number(n) * 100);
const num_ = (v) => { const n = typeof v === "number" ? v : parseFloat(String(v == null ? "" : v).replace(/[$,]/g, "")); return isFinite(n) ? n : 0; };
const str_ = (v) => String(v == null ? "" : v).replace(/\s+/g, " ").trim().slice(0, 200);

// Every number printed in the text, in cents ("1,234.50", "$4.5", "12" → 123450, 450, 1200).
function numbersInText_(text) {
  const set = new Set();
  for (const m of String(text).matchAll(/\d[\d,]*(?:\.\d+)?|\.\d+/g)) {
    const n = parseFloat(m[0].replace(/,/g, ""));
    if (isFinite(n)) set.add(cents_(n));
  }
  return set;
}

// What the model sent back, as an object: Workers AI's JSON mode answers {response: {...}} (some models
// a JSON string there, or an OpenAI-style {choices:[{message:{content}}]}).
function modelJson_(result) {
  let out = result && (result.response !== undefined ? result.response
    : result.choices && result.choices[0] && result.choices[0].message ? result.choices[0].message.content : result);
  if (typeof out === "string") {
    const s = out.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    try { out = JSON.parse(s); } catch (e) { return null; }
  }
  return out && typeof out === "object" && Array.isArray(out.lines) ? out : null;
}

// The model's answer → the layout reader's shape (admin.js parseVendorOrderPdf_), plus `warnings`.
// Exported for the tests; `text` is what the model was given.
export function invoiceFromModel(raw, text) {
  const printed = numbersInText_(text);
  const warnings = [];
  const lines = (raw.lines || []).filter(l => l && typeof l === "object").map(l => ({
    sku: str_(l.sku).replace(/^\*\s*/, ""), description: str_(l.description).replace(/^\*\s*/, ""),
    color: str_(l.color), size: str_(l.size),
    qty: Math.round(num_(l.qty)), unitCost: num_(l.unitCost), lineTotal: num_(l.lineTotal),
  })).filter(l => l.qty > 0);

  lines.forEach(l => {
    const name = [l.description || l.sku || "A line", l.color, l.size].filter(Boolean).join(" ");
    const missing = [["quantity", l.qty], ["price", l.unitCost], ["total", l.lineTotal]].filter(([, v]) => !printed.has(cents_(v))).map(([k]) => k);
    if (missing.length) warnings.push(`${name}: the ${missing.join(" and ")} isn't printed anywhere in the PDF — check it.`);
    else if (Math.abs(cents_(l.qty * l.unitCost) - cents_(l.lineTotal)) > 1) warnings.push(`${name}: ${l.qty} × $${l.unitCost.toFixed(2)} isn't $${l.lineTotal.toFixed(2)} — check it.`);
  });
  const subtotal = num_(raw.subtotal);
  const sum = lines.reduce((t, l) => t + cents_(l.lineTotal), 0);
  if (subtotal > 0 && Math.abs(sum - cents_(subtotal)) > 1)
    warnings.push(`The lines add up to $${(sum / 100).toFixed(2)}, but the invoice's subtotal is $${subtotal.toFixed(2)} — a line may be missing or misread.`);

  // Grouped by (description, color), like the layout reader: one candidate blank each, its sizes as lines.
  const groups = [], byKey = new Map();
  lines.forEach(l => {
    const key = l.description.toLowerCase() + "|" + l.color.toLowerCase();
    if (!byKey.has(key)) { const g = { description: l.description, color: l.color, sku: l.sku, lines: [] }; byKey.set(key, g); groups.push(g); }
    byKey.get(key).lines.push({ size: l.size, qty: l.qty, unitCost: l.unitCost, lineTotal: l.lineTotal });
  });
  const date = str_(raw.invoiceDate);
  const extra = Math.max(0, num_(raw.shipping)) + Math.max(0, num_(raw.otherCharges));
  return { vendor: str_(raw.vendor), vendorRef: str_(raw.vendorRef), receivedAt: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : "",
    extraCost: Math.round(extra * 100) / 100, groups, warnings, source: "ai" };
}

// Reads an invoice's text with the model. Throws a userFacing error for anything the admin can act on.
export async function readInvoiceWithAi(env, text) {
  if (!env || !env.AI || typeof env.AI.run !== "function")
    throw userError_("Reading with AI isn't set up on this install (no AI binding in wrangler.toml — see docs/configuration.md). Enter the order by hand with Receive order instead.");
  text = String(text || "").trim();
  if (!text) throw userError_("That PDF has no text to read — it may be a scan. Enter the order by hand with Receive order instead.");
  if (text.length > INVOICE_AI_MAX_CHARS) throw userError_("That PDF is too long to read with AI (about ten pages at most). Enter the order by hand with Receive order instead.");
  let result;
  try {
    result = await env.AI.run(INVOICE_AI_MODEL, {
      messages: [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: text }],
      response_format: { type: "json_schema", json_schema: INVOICE_SCHEMA },
      max_tokens: 8192, temperature: 0,
    });
  } catch (e) {
    console.error("Workers AI invoice read failed:", e);
    // Workers Free: error 4006 once the day's 10,000 neurons are used.
    if (/4006|daily free allocation|neurons/i.test(String(e && e.message)))
      throw userError_("Today's free AI allowance is used up (it resets at 00:00 UTC). Try again tomorrow, or enter the order by hand with Receive order.");
    throw userError_("Couldn't reach Cloudflare Workers AI just now. Try again, or enter the order by hand with Receive order.");
  }
  const raw = modelJson_(result);
  if (!raw) throw userError_("The AI couldn't read a line-item table in this PDF. Enter the order by hand with Receive order instead.");
  return invoiceFromModel(raw, text);
}
