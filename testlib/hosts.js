// The site's hostnames for tests, read from the real functions/_lib/hostConfig.js (its defaults, with no
// ROOT_DOMAIN set) — so a test never spells out the domain.
//   ROOT          the root domain ("example.com")
//   ADMIN_HOST    "admin.<root>"            ADMIN_ORIGIN  "https://admin.<root>"
//   shopHost(sub) "<sub>.<root>"            shopOrigin(sub) "https://<sub>.<root>"
const fs = require("fs");
const src = fs.readFileSync(__dirname + "/../functions/_lib/hostConfig.js", "utf8").replace(/export (async function|function|const)/g, "$1");
const H = new Function(src + "\nreturn { rootDomain, adminSubdomains };")();
const ROOT = H.rootDomain({});
const ADMIN_HOST = H.adminSubdomains({})[0] + "." + ROOT;
module.exports = {
  ROOT, ADMIN_HOST, ADMIN_ORIGIN: "https://" + ADMIN_HOST,
  shopHost: (sub) => sub + "." + ROOT, shopOrigin: (sub) => "https://" + sub + "." + ROOT,
};
