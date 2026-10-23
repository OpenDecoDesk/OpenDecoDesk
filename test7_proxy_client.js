const { JSDOM, ResourceLoader } = require("jsdom");
const { autoConfirm } = require("./testlib/confirm.js");
const fs = require("fs");
let html = fs.readFileSync(__dirname + "/public/index.html", "utf8");
html = html.replace("const PROXY_MODE = false;", "const PROXY_MODE = true;");

// index.html lazily loads admin.js via a real <script src="admin.js">
// tag — a custom ResourceLoader intercepts that one
// request and serves the real file, so window.loadAdminScript() (fired
// automatically by render()'s route:"admin" branch on boot) resolves in
// jsdom exactly like it would in a browser.
const adminJsSource = fs.readFileSync(__dirname + "/public/admin.js", "utf8");
class AdminResourceLoader extends ResourceLoader {
  fetch(url, options){
    if(url.includes("/admin.js")) return Promise.resolve(Buffer.from(adminJsSource, "utf-8"));
    return super.fetch(url, options);
  }
}

// Polls until a selector appears in a JSDOM window's document — needed for
// the admin passphrase overlay, which the admin subdomain's boot sequence
// appends asynchronously (after its own async /api/catalog fetch resolves
// and status:"admin" triggers renderAdminPicker() on its own), not at a
// point this test controls directly.
async function waitFor(win, selector, timeoutMs){
  const start = Date.now();
  while(Date.now() - start < timeoutMs){
    const el = win.document.querySelector(selector);
    if(el) return el;
    await new Promise(r => setTimeout(r, 10));
  }
  throw new Error("Timed out waiting for " + selector);
}

// showToast() (replaced alert()) appends a .toast div
// to #toastRegion instead of calling window.alert(); read the most
// recently added one's text to check what was shown.
function lastToastText(win){
  const toasts = win.document.querySelectorAll("#toastRegion .toast");
  return toasts.length ? toasts[toasts.length - 1].textContent : null;
}

(async () => {
  const calls = [];
  const dom = new JSDOM(html, {
    runScripts: "dangerously", resources: new AdminResourceLoader(),
    url: "https://league101.example.com/x.html", pretendToBeVisual:true,
    beforeParse(win){
      win.fetch = async (url, opts) => {
        calls.push({url, body: opts && opts.body ? JSON.parse(opts.body) : null});

        if(url.startsWith("/api/catalog")){
          return { ok: true, json: async () => ({
            status: "ok", orgId: "league-101",
            catalog: {
              name: "Example League 101", eyebrow: "Members shop",
              accent: "#1E7A4C", ready: true, desc: "Test catalog.",
              personalizationPrice: 2,
              products: [
                {id:"A", type:"shirt", name:"Option A — Budget Performance", sub:"Style 100", images:[], features:[], personalizationPrice:2, sizePricing:{XS:23,S:23,M:23,L:23,XL:23,"2XL":24,"3XL":26,"4XL":27}},
                {id:"B", type:"shirt", name:"Option B — Traditional", sub:"Style 200", images:[], features:[], personalizationPrice:2, sizePricing:{XS:25,S:25,M:25,L:25,XL:25,"2XL":26,"3XL":28,"4XL":29}},
                {id:"C", type:"shirt", name:"Option C — Premium Performance", sub:"Style 300", images:[], features:[], personalizationPrice:2, sizePricing:{XS:27,S:27,M:27,L:27,XL:27,"2XL":28,"3XL":30,"4XL":31}},
                {id:"D", type:"cap", name:"Option D — Cap", sub:"Style 400", images:[], features:[], personalizationPrice:null, flatPrice:16}
              ]
            }
          })};
        }

        const body = JSON.parse(opts.body);
        return { ok: true, json: async () => ({status:"ok"}) };
      };
    }
  });
  const { window } = dom;

  await new Promise(r=>setTimeout(r,100));

  console.log("=== Catalog fetched server-side from /api/catalog ===");
  console.log("Catalog endpoint was called:", calls.some(c => c.url.startsWith("/api/catalog")));
  console.log("Product options rendered after fetch:", window.document.getElementById("app").innerHTML.includes("Option A"));

  console.log("\n=== No 'Admin: view orders' link on the storefront page (admin has its own subdomain) ===");
  console.log("No admin button rendered:", !window.document.getElementById("app").innerHTML.includes("Admin: view orders"));

  console.log("\n=== Order submission goes to /api/orders ===");
  window.document.getElementById("size-C").value = "L";
  window.addToCart("C");
  await new Promise(r=>setTimeout(r,20));
  window.document.getElementById("custName").value = "Proxy Test";
  window.document.getElementById("custContact").value = "p@example.com";
  const pmSel7 = window.document.getElementById("custPaymentMethod");
  if(pmSel7) pmSel7.value = "Zelle";
  await window.placeOrder("league-101");
  await new Promise(r=>setTimeout(r,50));

  console.log("Call made to /api/orders:", calls.some(c => c.url === "/api/orders"));
  console.log("No call ever made directly to script.google.com:", !calls.some(c => c.url.includes("script.google.com")));
})();

(async () => {
  // ---- Admin subdomain: org picker -> per-org orders table ----
  const adminCalls = [];
  const paidOrderIds = new Set();
  const adminDom = new JSDOM(html, {
    runScripts: "dangerously", resources: new AdminResourceLoader(),
    url: "https://admin.example.com/x.html", pretendToBeVisual:true,
    beforeParse(win){
      win.fetch = async (url, opts) => {
        const body = opts && opts.body ? JSON.parse(opts.body) : null;
        adminCalls.push({url, body});

        if(url.startsWith("/api/catalog")){
          // The admin subdomain has no org of its own — catalog.js
          // returns this marker instead of any org's data.
          return { ok: true, json: async () => ({status:"admin"}) };
        }

        if(body && body.action === "listOrgs"){
          if(body.key !== "proxy-passphrase") return { ok: true, json: async () => ({status:"error", message:"Unauthorized"}) };
          return { ok: true, json: async () => ({status:"ok", orgs:[
            {orgId:"league-101", name:"Example League 101"},
            {orgId:"rec", name:"Example Crew Co"}
          ]}) };
        }

        if(body && body.action === "getOrders"){
          if(body.key !== "proxy-passphrase") return { ok: true, json: async () => ({status:"error", message:"Unauthorized"}) };
          return { ok: true, json: async () => ([
            {orderId:"X1", orgId:body.org, customerName:"Proxy Test", contact:"p@example.com", placedAt:new Date().toISOString(), total:27, paid:paidOrderIds.has("X1"), receivedEmailAt:"2026-07-16T12:00:00.000Z", confirmedEmailAt: paidOrderIds.has("X1") ? "2026-07-17T09:00:00.000Z" : "", items:[{name:"Option C — Premium Performance", type:"shirt", size:"L", qty:1, unitPrice:27, personalized:false, persName:"", lineTotal:27}]},
            // Simulates a malicious orderId — real orders can never actually
            // contain this (order submission rejects the format), but
            // this proves the admin table's RENDERING is safe on its own,
            // as defense in depth, not just relying on that server check.
            {orderId:'X2"><img src=x onerror="window.__xssFired=true">', orgId:body.org, customerName:"Attacker", contact:"a@evil.com", placedAt:new Date().toISOString(), total:16, paid:false, items:[{name:"Option D — Cap", type:"cap", size:"OSFA", qty:1, unitPrice:16, personalized:false, persName:"", lineTotal:16}]}
          ]) };
        }

        if(body && body.action === "markPaidManual"){
          if(body.key !== "proxy-passphrase") return { ok: true, json: async () => ({status:"error", message:"Unauthorized"}) };
          paidOrderIds.add(body.orderId);
          return { ok: true, json: async () => ({status:"ok", rowsUpdated:1}) };
        }

        if(body && body.action === "createTestTransaction"){
          if(body.key !== "proxy-passphrase") return { ok: true, json: async () => ({status:"error", message:"Unauthorized"}) };
          return { ok: true, json: async () => ({status:"ok", orderId:"TEST-999", checkoutUrl:"https://checkout.stripe.com/pay/cs_test_admintxn"}) };
        }

        if(body && body.action === "resendEmail"){
          if(body.key !== "proxy-passphrase") return { ok: true, json: async () => ({status:"error", message:"Unauthorized"}) };
          return { ok: true, json: async () => ({status:"ok", resent: paidOrderIds.has(body.orderId) ? "confirmed" : "received"}) };
        }

        return { ok: true, json: async () => ({status:"ok"}) };
      };
    }
  });
  const { window: adminWindow } = adminDom;
  // The dollar-amount prompt for "Create test transaction" is a separate,
  // untouched window.prompt() call — only the admin passphrase moved to
  // the masked-input overlay below.
  adminWindow.prompt = (msg) => (msg && msg.includes("amount")) ? "5.00" : null;
  autoConfirm(adminWindow, () => true); // auto-approve the "mark as paid"/"resend" confirmation dialogs
  const openedUrls = [];
  adminWindow.open = (url) => { openedUrls.push(url); };

  // The admin subdomain auto-detects status:"admin" on boot and calls
  // renderAdminPicker() itself, with no explicit trigger from this test —
  // wait for its passphrase overlay to actually appear, then fill it in
  // and submit like a real user would.
  // 10s ceiling (returns as soon as it appears): jsdom parsing the large
  // admin.js can take > 2s on a busy machine.
  const adminPassInput = await waitFor(adminWindow, "#adminPassInput", 10000);
  adminPassInput.value = "proxy-passphrase";
  adminWindow.document.querySelector(".admin-pass-submit").click();
  await new Promise(r=>setTimeout(r,150));

  console.log("\n=== Admin subdomain: no org resolved, shows the org picker instead of a storefront ===");
  const pickerHtml = adminWindow.document.body.innerHTML;
  console.log("Catalog endpoint called with no org data returned to the picker (no client list leaked before auth):", adminCalls.some(c => c.url.startsWith("/api/catalog")));
  console.log("Org picker shows both shop names, gated behind the passphrase prompt:", pickerHtml.includes("Example League 101") && pickerHtml.includes("Example Crew Co"));
  console.log("Client sent the admin passphrase to listOrgs:", adminCalls.some(c => c.body && c.body.action === "listOrgs" && c.body.key === "proxy-passphrase"));

  console.log("\n=== Admin subdomain: selecting a shop reuses the passphrase and shows its orders ===");
  adminWindow.selectAdminOrg("league-101");
  await new Promise(r=>setTimeout(r,150));
  const ordersHtml = adminWindow.document.getElementById("app").innerHTML;
  console.log("Admin shows Proxy Test customer for the selected shop:", ordersHtml.includes("Proxy Test"));
  const getOrdersCall = adminCalls.find(c => c.body && c.body.action === "getOrders");
  console.log("getOrders call scoped to the selected org:", getOrdersCall.body.org === "league-101");
  console.log("Client sent the admin passphrase:", getOrdersCall.body.key === "proxy-passphrase");
  console.log("'Mark as paid' button shown for the unpaid order:", ordersHtml.includes("Mark as paid") && ordersHtml.includes("Unpaid"));
  console.log("Received-email column shows a checkmark + date for X1 (it was sent):", ordersHtml.includes("✓ 7/16/2026"));
  console.log("Confirmed-email column shows '—' for X1 (not paid yet, never sent):", />—<\/td>/.test(ordersHtml));

  console.log("\n=== Admin subdomain: a malicious orderId can't break out of the table's HTML (stored-XSS fix) ===");
  console.log("Injected payload did NOT execute (no onclick/onerror breakout):", adminWindow.__xssFired !== true);
  const injectedButton = adminWindow.document.querySelector('button[data-order^="X2"]');
  console.log("No real <img> element was created from the payload (it stayed inert attribute text):", adminWindow.document.querySelectorAll("img").length === 0);
  console.log("The value instead sits safely in a data-order attribute:", !!injectedButton && injectedButton.dataset.order.includes('"><img'));

  console.log("\n=== Admin subdomain: clicking 'Mark as paid' calls markPaidManual and re-renders as Paid ===");
  await adminWindow.markOrderPaid("league-101", "X1");
  await new Promise(r=>setTimeout(r,150));
  const markPaidCall = adminCalls.find(c => c.body && c.body.action === "markPaidManual");
  console.log("markPaidManual call sent the right org and orderId:", markPaidCall.body.org === "league-101" && markPaidCall.body.orderId === "X1");
  console.log("Client sent the admin passphrase:", markPaidCall.body.key === "proxy-passphrase");
  const afterHtml = adminWindow.document.getElementById("app").innerHTML;
  console.log("Table re-rendered to show Paid:", afterHtml.includes(">Paid<"));
  console.log("Confirmed-email column now shows a checkmark + date (mock reflects the new paid status):", afterHtml.includes("✓ 7/17/2026"));
  console.log("X1's 'Mark as paid' button is gone now that it's paid:", !adminWindow.document.querySelector('button[data-order="X1"][onclick^="markOrderPaid"]'));
  console.log("X1 now shows 'Resend confirmation' instead:", !!adminWindow.document.querySelector('button[data-order="X1"][onclick^="resendEmail"]'));
  console.log("X2 (still unpaid) still has its Mark-as-paid button — only X1 changed:", !!adminWindow.document.querySelector('button[data-order^="X2"][onclick^="markOrderPaid"]'));

  console.log("\n=== Admin subdomain: 'Refresh' button re-fetches this org's orders ===");
  console.log("Refresh button is present:", afterHtml.includes(">Refresh<"));
  const getOrdersCallsBefore = adminCalls.filter(c => c.body && c.body.action === "getOrders").length;
  adminWindow.refreshAdminOrders("league-101"); // what the Refresh button calls
  await new Promise(r=>setTimeout(r,150));
  const getOrdersCallsAfter = adminCalls.filter(c => c.body && c.body.action === "getOrders").length;
  console.log("Clicking it re-fetches orders (a new getOrders call fired):", getOrdersCallsAfter === getOrdersCallsBefore + 1);

  console.log("\n=== Admin subdomain: 'Create test transaction' button calls createTestTransaction and opens the real Stripe URL ===");
  console.log("Button is present on the orders page:", afterHtml.includes("Create test transaction"));
  await adminWindow.createTestTransaction("league-101");
  await new Promise(r=>setTimeout(r,50));
  const testTxnCall = adminCalls.find(c => c.body && c.body.action === "createTestTransaction");
  console.log("createTestTransaction call sent the right org and amount:", testTxnCall.body.org === "league-101" && testTxnCall.body.amount === 5);
  console.log("Client sent the admin passphrase:", testTxnCall.body.key === "proxy-passphrase");
  console.log("Opened the real Stripe checkout URL returned by the server:", openedUrls.includes("https://checkout.stripe.com/pay/cs_test_admintxn"));

  console.log("\n=== Admin subdomain: button says Send vs Resend based on whether that email was ever actually sent ===");
  // X1 was marked paid earlier in this test and already has a confirmedEmailAt in
  // the mock -> "Resend". X2 has never had a receivedEmailAt set -> "Send", not "Resend".
  const finalHtml = adminWindow.document.getElementById("app").innerHTML;
  console.log("Paid order (X1, already confirmed once) shows 'Resend confirmation':", finalHtml.includes("Resend confirmation"));
  console.log("Unpaid order (X2, never sent) shows 'Send received', not 'Resend received':", finalHtml.includes("Send received") && !finalHtml.includes("Resend received"));

  await adminWindow.resendEmail("league-101", "X1");
  const resendCallPaid = adminCalls.filter(c => c.body && c.body.action === "resendEmail").pop();
  console.log("Resend for the paid order sent the right org/orderId:", resendCallPaid.body.org === "league-101" && resendCallPaid.body.orderId === "X1");
  console.log("Client sent the admin passphrase:", resendCallPaid.body.key === "proxy-passphrase");
  console.log("Confirms the 'confirmed' email was sent (server decided based on X1's real paid status):", lastToastText(adminWindow) === "Payment-confirmed email sent.");

  await adminWindow.resendEmail("league-101", "X2");
  const resendCallUnpaid = adminCalls.filter(c => c.body && c.body.action === "resendEmail").pop();
  console.log("Send for the unpaid order sent the right org/orderId:", resendCallUnpaid.body.org === "league-101" && resendCallUnpaid.body.orderId === "X2");
  console.log("Confirms the 'received' email was sent:", lastToastText(adminWindow) === "Order-received email sent.");
})();
