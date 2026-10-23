// Receipt emails add up: the order-received and payment-confirmed emails list the items,
// then Subtotal, Shipping (with its method, or "TBD" for a custom quote), Discount and Total —
// listing only the products before the total would leave the numbers not adding up once shipping
// is charged. Cancelled lines are left out. Real email.js;
// the email send is mocked to capture each message.
const fs = require("fs");
const { MAIL_ENV, MAIL_OK, captureMail } = require("./testlib/mail-mock");
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src
  .replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "")
  .replace(/export (async function|function|const)/g, "$1");

const sent = [];
global.fetch = async (url, init) => {
  if (captureMail(url, init, sent)) return MAIL_OK;
  throw new Error("unexpected fetch " + url);
};
const E = new Function("const recordSystemIssue = async () => {};\n" + strip(read("functions/_lib/email.js")) +
  "\nreturn { sendOrderReceivedEmail, sendPaymentConfirmedEmail, sendDailyDigestEmail };")();
const env = { ...MAIL_ENV };
const plain = (html) => html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ");

(async () => {
  try {
    console.log("=== Order received, with shipping ===");
    await E.sendOrderReceivedEmail(env, { orderId: "PRIME-1", customerName: "Ann", contact: "a@x.com", paymentMethod: "Card",
      items: [{ name: "Polo", size: "L", qty: 2, lineTotal: 32 }, { name: "Cap", size: "", qty: 1, lineTotal: 24 }],
      subtotal: 56, shippingCost: 8.25, shippingMethod: "USPS Ground Advantage", total: 64.25, salesTax: 3.17, taxRate: 6 });
    let m = sent.pop(), h = plain(m.htmlBody || m.html || "");
    console.log("items, then Subtotal $56.00, Shipping (method) $8.25, Total $64.25 — in that order:",
      /Polo .*Cap .*Subtotal \$56\.00 Shipping \(USPS Ground Advantage\) \$8\.25 Total \$64\.25/.test(h));
    console.log("the sales-tax note stays under the total:", /Total \$64\.25 Includes sales tax \(6%\) \$3\.17/.test(h));
    console.log("the plain-text version has the same lines:", /Subtotal: \$56\.00\nShipping \(USPS Ground Advantage\): \$8\.25\nTotal: \$64\.25 \(includes \$3\.17 sales tax\)/.test(m.body || m.text || ""));

    console.log("\n=== Order received, no shipping (pickup) ===");
    await E.sendOrderReceivedEmail(env, { orderId: "PRIME-2", customerName: "Bo", contact: "b@x.com", paymentMethod: "Venmo",
      items: [{ name: "Cap", size: "", qty: 1, lineTotal: 24 }], subtotal: 24, shippingCost: 0, total: 24 });
    h = plain(sent.pop().htmlBody);
    console.log("Subtotal and Total, no shipping line:", /Subtotal \$24\.00 Total \$24\.00/.test(h) && !/Shipping/.test(h));

    console.log("\n=== Order received, shipping quote pending ===");
    await E.sendOrderReceivedEmail(env, { orderId: "PRIME-3", customerName: "Cy", contact: "c@x.com", paymentMethod: "Check", manualShipping: true,
      items: [{ name: "Hoodie", size: "XL", qty: 1, lineTotal: 45 }], subtotal: 45, shippingCost: 0, total: 45 });
    m = sent.pop(); h = plain(m.htmlBody);
    console.log("Subtotal, Shipping TBD, and no total yet (the follow-up email has it):", /Subtotal \$45\.00 Shipping TBD/.test(h) && !/Total \$/.test(h) && /Shipping: TBD/.test(m.body));

    console.log("\n=== Payment confirmed — a saved order with shipping, a discount and a cancelled line ===");
    await E.sendPaymentConfirmedEmail(env, { orderId: "ORD-SAMPLE01", customerName: "Dee", contact: "d@x.com",
      items: [{ name: "Tee", size: "M", qty: 2, lineTotal: 44 }, { name: "Cap", size: "", qty: 1, lineTotal: 24, cancelDate: "2026-09-02" }],
      itemsSubtotal: 44, shippingCost: 6.25, shippingMethod: "USPS Ground Advantage", discountAmount: 4, discountNote: "Club",
      effectiveTotal: 46.25, total: 68, salesTax: 2.26, taxRate: 6 }, "2026-09-22T00:00:00Z");
    m = sent.pop(); h = plain(m.htmlBody);
    console.log("shipping is shown now (it wasn't before):", /Shipping \(USPS Ground Advantage\) \$6\.25/.test(h));
    console.log("Subtotal $44.00 + Shipping $6.25 − Discount $4.00 = Total $46.25 (the order's current total, not the stale stored one):",
      /Subtotal \$44\.00 Shipping \(USPS Ground Advantage\) \$6\.25 Discount \(Club\) −\$4\.00 Total \$46\.25/.test(h) && !/\$68\.00/.test(h));
    console.log("the cancelled line isn't listed:", /Tee/.test(h) && !/Cap/.test(h));
    console.log("plain text adds up too:", /Subtotal: \$44\.00\nShipping \(USPS Ground Advantage\): \$6\.25\nDiscount: −\$4\.00\nTotal: \$46\.25/.test(m.body));

    // A configurable line (migrations/0036) shows its garment colour + per-location picks in the
    // receipt — not just the product name — so the customer sees what they configured. The invisible
    // reorder-QR application and any auto-added entries are left out.
    console.log("\n=== Order received — a configurable line's picks ===");
    await E.sendOrderReceivedEmail(env, { orderId: "COL-1", customerName: "Fen", contact: "f@x.com", paymentMethod: "Card",
      items: [{ name: "Raglan", size: "L", qty: 1, lineTotal: 22, personalized: false, persName: "",
        config: { garmentColor: "Navy", locations: [
          { location: "front", label: "Front", graphicName: "Lockup", ink: "White" },
          { location: "back", label: "Back", graphicName: "Capital" },
          { location: "reorderqr", label: "Reorder QR", graphicName: "QR", auto: true } ] } }],
      subtotal: 22, shippingCost: 0, total: 22 });
    m = sent.pop(); h = plain(m.htmlBody);
    console.log("the HTML receipt shows colour + both locations, not the reorder QR:",
      /Raglan .*Navy · Front: Lockup \(White\) · Back: Capital/.test(h) && !/Reorder QR/.test(h));

    // The owner roll-up lists the same config summary in brackets after the item.
    const cfgOrder = { orgId: "colonnade", orderId: "COL-1", customerName: "Fen", contact: "f@x.com",
      placedAt: "2026-10-07T12:00:00Z", paymentMethod: "Card", total: 22,
      items: [{ name: "Raglan", size: "L", qty: 1, lineTotal: 22, personalized: false, persName: "",
        config: { garmentColor: "Navy", locations: [
          { location: "front", label: "Front", graphicName: "Lockup", ink: "White" },
          { location: "back", label: "Back", graphicName: "Capital" },
          { location: "reorderqr", label: "Reorder QR", graphicName: "QR", auto: true } ] } }] };
    await E.sendDailyDigestEmail(env, { orders: [cfgOrder], orgNames: { colonnade: "Colonnade" } });
    m = sent.pop(); h = plain(m.htmlBody); const txt = m.body || m.text || "";
    console.log("the owner roll-up shows the summary in brackets, not the reorder QR:",
      /Raglan \(L\) \[Navy · Front: Lockup \(White\) · Back: Capital\]/.test(h) &&
      /Raglan \(L\) \[Navy · Front: Lockup \(White\) · Back: Capital\]/.test(txt) && !/Reorder QR/.test(txt));
  } catch (e) {
    console.log("test76 crashed:", false);
    console.error(e);
    process.exit(1);
  }
})();
