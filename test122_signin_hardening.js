// Sign-in hardening, for per-user accounts:
//   * failed sign-ins are counted per IPv6 /64 (one machine can't get a fresh budget by moving within
//     its own block) and against one install-wide budget (ADMIN_AUTH_GLOBAL_LIMIT, default 100 per
//     15 minutes, 0 = off);
//   * a signed-in user is let through before any failure budget is looked at, so junk from their own
//     address can't lock them out;
//   * the sign-in endpoint refuses a post from another site before counting it;
//   * Sign out everywhere ends every session of that user (and only theirs);
//   * turning two-step on or off ends the user's other sessions; wrong codes there are limited to 5 a
//     minute, and a code already used can't be used again (to switch two-step off, say);
//   * the spreadsheet export turns tabs, line breaks and control characters into a space.
// The real adminAuth.js, admin-session.js, admin-2fa.js and rateLimit.js on real SQL (sql.js).
const { makeAuth, totpNow, request, answer, read } = require("./testlib/auth-harness");

let pass = 0, fail = 0;
const ok = (d, c) => { console.log(d + ":", !!c); c ? pass++ : fail++; };

(async () => {
  const A = await makeAuth({ realLimits: true });
  const L = A.limits;
  let r;
  const clearLimits = () => A.d1._raw.run("DELETE FROM rate_limits");
  // A sign-in post from a given address (and, optionally, another site).
  const signInFrom = async (ip, email, key, origin) => answer(await A.raw["/api/admin-session"].POST({ env: A.env,
    request: request("/api/admin-session", { email, key }, { headers: { "cf-connecting-ip": ip }, ...(origin ? { origin } : {}) }) }));

  console.log("=== Counting by address ===");
  ok("an IPv6 address counts by its /64", L.ipv6Prefix64("2001:db8:1:2:3:4:5:6") === "2001:db8:1:2::/64" && L.ipv6Prefix64("2001:0DB8:0001:0002::ff") === "2001:db8:1:2::/64" &&
    L.ipv6Prefix64("2001:db8::1") === "2001:db8:0:0::/64");
  ok("an IPv4 address, an IPv4-mapped one and something unreadable are counted as written", L.ipv6Prefix64("::ffff:192.0.2.1") === "::ffff:192.0.2.1" && L.ipv6Prefix64("nonsense:x") === "nonsense:x");

  const admin = await A.firstAdmin();
  clearLimits();
  for (let i = 1; i <= 10; i++) await signInFrom("2001:db8:1:2::" + i.toString(16), "olive@myshop.com", "wrong password");
  ok("ten tries from addresses in one /64 use up that /64's budget", (await signInFrom("2001:db8:1:2::ff", "olive@myshop.com", "correct horse battery")).status === 429);
  ok("…while the next /64 has its own", (await signInFrom("2001:db8:1:3::1", "olive@myshop.com", "correct horse battery")).status === 200);
  clearLimits();

  console.log("\n=== Another site can't spend the budget ===");
  let crossAll = true;
  for (let i = 0; i < 15; i++) crossAll = crossAll && (await signInFrom("198.51.100.7", "olive@myshop.com", "x", "https://evil.example")).status === 403;
  ok("posts from another site are refused before they're counted, so the owner of the address can still sign in", crossAll && (await signInFrom("198.51.100.7", "olive@myshop.com", "correct horse battery")).status === 200);
  clearLimits();

  const gate = (cookie, key, ip) => A.lib.requireAdmin(A.env, { kind: "admin" }, key || "", request("/api/orders", {}, { cookie, headers: { "cf-connecting-ip": ip || "203.0.113.9" } }), "no", "staff");
  console.log("\n=== A signed-in user can't be locked out from their own address ===");
  for (let i = 0; i < 12; i++) await gate("", "a wrong key", "203.0.113.50");
  ok("junk from the same address uses up its budget…", (await gate("", "a wrong key", "203.0.113.50")).status === 429);
  ok("…and the signed-in user on that address is still let in", (await gate(admin, "", "203.0.113.50")) === null);
  clearLimits();

  console.log("\n=== Sign out everywhere ===");
  const second = (await signInFrom("203.0.113.9", "olive@myshop.com", "correct horse battery")).cookie;
  const staff = await A.addUser(admin, "staff", "Sam Staff", "sam@myshop.com");
  const olive = A.user("olive@myshop.com"), sam = A.user("sam@myshop.com");
  const sessionsOf = (u) => A.d1.q("SELECT count(*) n FROM admin_sessions WHERE userId=?", u.id)[0].n;
  ok("(Olive is signed in twice, Sam once)", sessionsOf(olive) >= 2 && sessionsOf(sam) === 1);
  const out = await answer(await A.raw["/api/admin-session"].DELETE({ env: A.env,
    request: Object.assign(request("/api/admin-session?all=1", null, { cookie: second }), { url: "https://admin.example.com/api/admin-session?all=1", method: "DELETE" }) }));
  ok("signing out everywhere ends every session of that user, this one included", out.status === 200 && sessionsOf(olive) === 0 && (await gate(admin)) !== null && (await gate(second)) !== null);
  ok("…and nobody else's", sessionsOf(sam) === 1 && (await gate(staff)) === null);
  ok("…and is audited", A.audit("security.signed_out_everywhere").length === 1);
  ok("a plain sign-out ends only its own session", (await A.signOut(staff)).status === 200 && sessionsOf(sam) === 0);
  clearLimits();

  console.log("\n=== Two-step: sessions, wrong codes, used codes ===");
  const me = (await signInFrom("203.0.113.9", "olive@myshop.com", "correct horse battery")).cookie;
  const other = (await signInFrom("203.0.113.10", "olive@myshop.com", "correct horse battery")).cookie;
  const SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
  let wrong = [];
  for (let i = 0; i < 5; i++) wrong.push((await A.twoFactor({ action: "activate", proposedSecret: SECRET, code: "000000" }, me)).status);
  ok("wrong codes are refused…", wrong.every(s => s === 400));
  ok("…five a minute, then not even checked", (await A.twoFactor({ action: "activate", proposedSecret: SECRET, code: totpNow(SECRET) }, me)).status === 429);
  const elsewhere = { headers: { "cf-connecting-ip": "203.0.113.30" } };   // that address's budget is spent for this minute
  r = await A.twoFactor({ action: "activate", proposedSecret: SECRET, code: totpNow(SECRET) }, me, elsewhere);
  const recovery = (r.body.recoveryCodes || [])[0];
  ok("turning two-step on ends the user's other sessions, not this one", r.status === 200 && (await gate(me)) === null && (await gate(other)) !== null);
  r = await A.twoFactor({ action: "disable", code: totpNow(SECRET) }, me, elsewhere);
  ok("the code that turned it on can't switch it off again", r.status === 400 && /already used/.test(r.body.message) && !!A.user("olive@myshop.com").totpSecret);
  const another = (await answer(await A.raw["/api/admin-session"].POST({ env: A.env, request: request("/api/admin-session",
    { email: "olive@myshop.com", key: "correct horse battery", totpCode: totpNow(SECRET, 1) }, { headers: { "cf-connecting-ip": "203.0.113.11" } }) }))).cookie;
  r = await A.twoFactor({ action: "disable", code: totpNow(SECRET, 1) }, me, elsewhere);
  ok("…nor can a code already used to sign in", r.status === 400 && /already used/.test(r.body.message));
  // (Every code in the app's window has now been used; a recovery code proves the second factor too.)
  r = await A.twoFactor({ action: "disable", code: recovery }, me, elsewhere);
  ok("a recovery code switches it off, and that ends the other sessions", r.status === 200 && !A.user("olive@myshop.com").totpSecret && (await gate(me)) === null && !!another && (await gate(another)) !== null);

  const fresh = (await signInFrom("203.0.113.20", "olive@myshop.com", "correct horse battery")).cookie;
  console.log("\n=== One budget for the whole install ===");
  ok("the install-wide limit is 100 unless set; 0 turns it off", L && (await (async () => {
    const lim = new Function(read("functions/_lib/adminAuth.js").match(/export function adminAuthGlobalLimit[\s\S]*?\n}/)[0].replace("export ", "") + "\nreturn adminAuthGlobalLimit;")();
    return lim({}) === 100 && lim({ ADMIN_AUTH_GLOBAL_LIMIT: "0" }) === 0 && lim({ ADMIN_AUTH_GLOBAL_LIMIT: "25" }) === 25 && lim({ ADMIN_AUTH_GLOBAL_LIMIT: "" }) === 100;
  })()));
  A.env.ADMIN_AUTH_GLOBAL_LIMIT = "5";
  for (let i = 1; i <= 5; i++) await signInFrom("192.0.2." + i, "olive@myshop.com", "wrong password");
  r = await signInFrom("192.0.2.99", "olive@myshop.com", "correct horse battery");
  ok("five failures from five addresses use up a limit of 5: a sixth address can't sign in either", r.status === 429);
  ok("…but someone already signed in carries on", (await gate(fresh)) === null);
  ok("…and a passphrase sent without a session is refused while it lasts", (await gate("", "anything", "192.0.2.50")).status === 429);
  A.env.ADMIN_AUTH_GLOBAL_LIMIT = "0";
  ok("with the limit at 0 it's off", (await signInFrom("192.0.2.100", "olive@myshop.com", "correct horse battery")).status === 200);
  delete A.env.ADMIN_AUTH_GLOBAL_LIMIT;
  clearLimits();

  console.log("\n=== Spreadsheet export ===");
  const adminJs = read("public/admin.js");
  const csvSafe = new Function(adminJs.match(/function csvSafe\(value\)\{[\s\S]*?\n\}/)[0] + "\nreturn csvSafe;")();
  ok("a tab or line break in a value becomes a space, so it can't start a cell or row of its own", csvSafe("Ann\t=SUM(A1)") === "Ann =SUM(A1)" && csvSafe("x\r\n=1") === "x =1" && csvSafe("a b") === "a b");
  ok("a value that starts like a formula is still made text", csvSafe("=1+1") === "'=1+1" && csvSafe("\t=1") === "' =1" && csvSafe("@x") === "'@x");
  ok("the Security menu offers Sign out everywhere", /\{ action: "adminSignOutEverywhere\(\)", label: "Sign out everywhere" \}/.test(adminJs) && /fetch\("\/api\/admin-session\?all=1", \{ method: "DELETE" \}\)/.test(adminJs));

  console.log(`\n${pass} passed, ${fail} failed`);
})().catch(e => { console.error(e); console.log("test122 ran to the end without crashing: false"); process.exitCode = 1; });
