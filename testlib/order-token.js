// The token /api/orders returns with a new order and /api/checkout asks for (functions/_lib/http.js),
// made here with the real code so a test can start a checkout the way the storefront does.
const fs = require("fs");
const src = fs.readFileSync(__dirname + "/../functions/_lib/http.js", "utf8").replace(/export (async function|function|const)/g, "$1");
const H = new Function(src + "\nreturn { signOrderToken, verifyOrderToken };")();
module.exports = { orderTokenFor: (env, orderId) => H.signOrderToken(env, orderId), verifyOrderToken: H.verifyOrderToken };
