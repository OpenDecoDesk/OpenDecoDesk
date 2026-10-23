const fs = require("fs");

// Inline the shared _lib/hostConfig.js module into catalog.js for this
// eval-based test harness (the real deployed files use proper ES
// `import`/`export`, which the Workers runtime supports natively — this
// concatenation is only a stand-in so we can exercise the same logic
// under plain Node without a bundler).
let libSrc = fs.readFileSync(__dirname + "/functions/_lib/hostConfig.js", "utf8")
  .replace(/export const/g, "const")
  .replace(/export function/g, "function");
let httpSrc = fs.readFileSync(__dirname + "/functions/_lib/http.js", "utf8")
  .replace(/export function/g, "function");

// getCatalogData(env) mock — org identity/product/pricing data in the
// orgs/subdomainMap shape functions/_lib/catalogCache.js provides.
global.getCatalogData = async () => ({
  subdomainMap: {
    "league101": "league-101",
    "league202": "league-202",
    "league303": "league-303",
    "club404": "club-404",
    "rec": "rec"
  },
  orgs: {
    "league-101": {
      name: "Example League 101",
      eyebrow: "Members shop",
      accent: "#1E7A4C",
      ready: true,
      desc: "Embroidered polos and a coordinating cap.",
      designImages: { shirt: "images/design-on-shirt.png", cap: "images/design-on-cap.png", detail: "images/design-detail.png" },
      products: [
        { productId:"A", type:"shirt", name:"Option A — Budget Performance", sub:"Style 100 · poly interlock, UPF 50 sun protection", images:["images/polo-a-front.jpg"], features:[], personalizationPrice:2, pricingMode:"sized", sizePricing:{XS:23,S:23,M:23,L:23,XL:23,"2XL":24,"3XL":26,"4XL":27} }
      ]
    },
    "league-202": { name:"Second League 202", eyebrow:"Members shop", accent:"#2E5D9B", ready:false, desc:"Catalog in progress.", designImages:{shirt:"",cap:"",detail:""}, products:[] },
    "league-303": { name:"Third League 303", eyebrow:"Members shop", accent:"#C9A84C", ready:false, desc:"Catalog in progress.", designImages:{shirt:"",cap:"",detail:""}, products:[] },
    "club-404": { name:"Example Club 404", eyebrow:"Youth group", accent:"#4A5D23", ready:false, desc:"Catalog in progress.", designImages:{shirt:"",cap:"",detail:""}, products:[] },
    "rec": { name:"Example Crew Co", eyebrow:"Work crew shop", accent:"#F6921E", ready:true, desc:"Sun-protection hoodies.", designImages:{shirt:"",cap:"",detail:""}, products:[] }
  }
});

let catalogSrc = fs.readFileSync(__dirname + "/functions/api/catalog.js", "utf8")
  .replace(/import \{ classifyHost \} from ["'].*["'];\n?/, "")
  .replace(/import \{ getCatalogData \} from ["'].*["'];\n?/, "")
  .replace(/import \{ getReadyToShipByOrg[^}]*\} from ["'].*["'];\n?/, "")
  .replace(/export const CATALOGS/, "var CATALOGS")
  .replace(/import \{ jsonResponse \} from ["'].*["'];\n?/, "")
  .replace(/export async function/g, "async function");

eval(libSrc + "\n" + httpSrc + "\n" + catalogSrc);

function makeContext(url){
  return { request: { url }, env: { STRIPE_SECRET_KEY: "sk_test_fake" } };
}

(async () => {
  console.log("=== Locked subdomain: gets its OWN catalog regardless of ?org= param ===");
  const res1 = await onRequestGet(makeContext("https://club404.example.com/api/catalog?org=league-101"));
  const data1 = JSON.parse(await res1.text());
  console.log("Returned orgId is club-404 (its own), NOT league-101 (what was requested):", data1.orgId === "club-404");
  console.log("No Example League pricing leaked into an Example Club 404 request:",
    JSON.stringify(data1).includes("Example League") === false &&
    JSON.stringify(data1).includes("Style 100") === false);

  console.log("\n=== Locked subdomain with no org param at all still gets only its own ===");
  const res2 = await onRequestGet(makeContext("https://league101.example.com/api/catalog"));
  const data2 = JSON.parse(await res2.text());
  console.log("Returned orgId:", data2.orgId, "(expect league-101)");
  console.log("Includes real product data for its own org:", JSON.stringify(data2).includes("Style 100"));

  console.log("\n=== Card payment enabled is derived server-side from STRIPE_SECRET_KEY, not a client-side constant ===");
  console.log("Card included in enabledPayments when Stripe is configured:", Array.isArray(data2.catalog.enabledPayments) && data2.catalog.enabledPayments.includes("Card"));
  const res2b = await onRequestGet({ request: { url: "https://league101.example.com/api/catalog" }, env: {} });
  const data2b = JSON.parse(await res2b.text());
  console.log("Card absent from enabledPayments when STRIPE_SECRET_KEY isn't set:", Array.isArray(data2b.catalog.enabledPayments) && !data2b.catalog.enabledPayments.includes("Card"));

  console.log("\n=== Root/hub domain: ignores ?org= (no way to confirm which org IDs exist) ===");
  const res3 = await onRequestGet(makeContext("https://example.com/api/catalog?org=club-404"));
  const data3 = JSON.parse(await res3.text());
  const res3b = await onRequestGet(makeContext("https://example.com/api/catalog?org=totally-fake-org"));
  const data3b = JSON.parse(await res3b.text());
  console.log("A real org ID gets no catalog on the hub domain:", data3.status === "error" && !data3.catalog && !data3.orgId);
  console.log("…and the exact same answer as a made-up one:", res3.status === res3b.status && JSON.stringify(data3) === JSON.stringify(data3b));

  console.log("\n=== Unknown org id is rejected cleanly ===");
  const res4 = await onRequestGet(makeContext("https://example.com/api/catalog?org=totally-fake-org"));
  const data4 = JSON.parse(await res4.text());
  console.log("Rejected with error:", data4.status === "error");

  console.log("\n=== Unrecognized subdomain (e.g. wildcard DNS catch-all) is REFUSED, not treated as hub ===");
  const res5 = await onRequestGet(makeContext("https://randomguess.example.com/api/catalog?org=league-202"));
  const data5 = JSON.parse(await res5.text());
  console.log("Refused with 'Unrecognized host', not silently given Second League's data:",
    data5.status === "error" && data5.message === "Unrecognized host");

  console.log("\n=== .pages.dev preview domain is refused (it isn't one of the install's hosts) ===");
  const res6 = await onRequestGet(makeContext("https://my-project-abc123.pages.dev/api/catalog?org=club-404"));
  const data6 = JSON.parse(await res6.text());
  console.log("Preview domain is refused as unrecognized host (not treated as root):", data6.status === "error" && data6.message === "Unrecognized host");

  console.log("\n=== Admin subdomain has no storefront of its own — no org data, no client list leaked ===");
  const res7 = await onRequestGet(makeContext("https://admin.example.com/api/catalog"));
  const data7 = JSON.parse(await res7.text());
  console.log("Returns the admin marker, not an org:", data7.status === "admin" && !data7.orgId && !data7.catalog);
  console.log("No org name leaked into the response even unauthenticated:",
    !JSON.stringify(data7).includes("Example League") && !JSON.stringify(data7).includes("Sam Sample"));

  console.log("\n=== Admin subdomain ignores a ?org= param too — it never serves a storefront ===");
  const res8 = await onRequestGet(makeContext("https://admin.example.com/api/catalog?org=league-101"));
  const data8 = JSON.parse(await res8.text());
  console.log("Still just the admin marker, org param ignored:", data8.status === "admin" && !data8.catalog);

  console.log("\n=== The root domain and the admin label are settings (ROOT_DOMAIN / ADMIN_SUBDOMAIN) ===");
  const withEnv = (url, extra) => ({ request: { url }, env: Object.assign({ STRIPE_SECRET_KEY: "sk_test_fake" }, extra) });
  let d9 = JSON.parse(await (await onRequestGet(makeContext("https://office.example.com/api/catalog"))).text());
  console.log("an unlisted label isn't the admin panel:", d9.status !== "admin");
  d9 = JSON.parse(await (await onRequestGet(withEnv("https://office.example.com/api/catalog", { ADMIN_SUBDOMAIN: "admin, office" }))).text());
  console.log("ADMIN_SUBDOMAIN adds one (several, comma-separated):", d9.status === "admin" && !d9.catalog);
  d9 = JSON.parse(await (await onRequestGet(withEnv("https://admin.stitches.test/api/catalog", { ROOT_DOMAIN: "stitches.test" }))).text());
  console.log("ROOT_DOMAIN moves the whole site to another domain:", d9.status === "admin");
  d9 = JSON.parse(await (await onRequestGet(withEnv("https://admin.example.com/api/catalog", { ROOT_DOMAIN: "www.Stitches.test" }))).text());
  console.log("…and the old domain is then just an unrecognized host:", d9.status === "error" && d9.message === "Unrecognized host");
})();
