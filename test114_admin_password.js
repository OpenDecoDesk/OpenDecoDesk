const fs = require("fs");
const { createD1 } = require("./testlib/d1-shim.js");
const { makeAuth, totpNow, read } = require("./testlib/auth-harness");

// Getting in, and passwords. The installer prints a passphrase (the PROXY_ADMIN_PASSPHRASE
// secret). It opens the admin only while no active admin has a password of their own: on a new
// install, and on one that was locked out and recovered by replacing the secret. Whoever gets in
// that way must first set a name, an email and a password; after that, people sign in with their
// email and password, the passphrase is dead, and each user's password is a salted hash keyed
// with the secret. An install from before there were users keeps its owner, password and
// two-step secret. Real SQL (sql.js) under the real adminAuth.js and the account endpoints.
let pass = 0, fail = 0;
const ok = (d, c) => { console.log(d + ":", !!c); c ? pass++ : fail++; };
const SECRET = "JBSWY3DPEHPK3PXP", SECRET2 = "KRSXG5CTMVRXEZLU";

(async () => {
  console.log("=== A new install: the printed passphrase, once ===");
  let A = await makeAuth();
  let a = await A.signIn("anything@at.all", "wrong-wrong-wrong");
  ok("a wrong passphrase is refused, and nothing is created", a.status === 401 && A.d1.q("SELECT count(*) n FROM users")[0].n === 0);
  a = await A.signIn("", A.PRINTED);
  ok("the printed passphrase signs in as the first admin, with their account still to set up", a.status === 200 && a.body.pending === "account" && a.body.user.role === "admin" && /^sess_[0-9a-f]{48}$/.test(a.cookie));
  ok("…one admin row exists, and the sign-in is in the audit log", A.d1.q("SELECT role, status, email FROM users").map(u => u.role + u.status + u.email).join() === "adminactive" && A.audit("security.first_signin").length === 1);
  const first = a.cookie;
  ok("until the account is set up nothing else answers: 403 with a reason the page can act on", (a = await A.users({ action: "list" }, first)).status === 403 && a.body.code === "setup_required" && a.body.pending === "account" &&
    (await A.twoFactor({ action: "status" }, first)).status === 403);
  ok("…except asking who you are and where you stand", (a = await A.users({ action: "me" }, first)).status === 200 && a.body.pending === "account" && (a = await A.password({ action: "status" }, first)).status === 200 && a.body.hasPassword === false && a.body.minLength === 12);
  ok("being told to finish setting up is not counted as a failed sign-in", A.hits.length === 0);
  const NEW = "correct horse battery";
  ok("the account needs a name and a real email", (await A.password({ action: "account", name: "", email: "olive@myshop.com", next: NEW }, first)).status === 400 && (await A.password({ action: "account", name: "Olive", email: "olive", next: NEW }, first)).status === 400);
  ok("…and a password: long enough, not the printed passphrase, no stray spaces, text", (a = await A.password({ action: "account", name: "Olive", email: "olive@myshop.com", next: "short" }, first)).status === 400 && /at least 12/.test(a.body.message) &&
    (await A.password({ action: "account", name: "Olive", email: "olive@myshop.com", next: A.PRINTED }, first)).status === 400 && (await A.password({ action: "account", name: "Olive", email: "olive@myshop.com", next: " " + NEW }, first)).status === 400 &&
    (await A.password({ action: "account", name: "Olive", email: "olive@myshop.com", next: [NEW] }, first)).status === 400 && (await A.password({ action: "account", name: "Olive", email: "olive@myshop.com" }, first)).status === 400 && A.user("olive@myshop.com") === null);
  a = await A.password({ action: "account", name: "Olive Owner", email: "Olive@MyShop.com", next: NEW }, first);
  ok("a good one is accepted; the browser is signed out so the next step is a sign-in with it", a.status === 200 && a.body.signInAgain === true && a.cookie === "" && A.sessions() === 0 && (await A.users({ action: "me" }, first)).status === 401);
  const olive = A.user("olive@myshop.com"), rec = JSON.parse(olive.password);
  ok("what is stored is a salted hash, the email in lower case, and no trace of the password or the passphrase", olive.name === "Olive Owner" && /^[0-9a-f]{64}$/.test(rec.hash) && /^[0-9a-f]{32}$/.test(rec.salt) &&
    !JSON.stringify(A.d1.q("SELECT * FROM users")).includes(NEW) && !JSON.stringify(A.d1.q("SELECT * FROM global_settings")).includes(A.PRINTED) && !JSON.stringify(A.d1.q("SELECT * FROM audit_log")).includes(NEW));

  console.log("\n=== After that: email and password ===");
  ok("the printed passphrase no longer signs in, whatever email is typed", (await A.signIn("", A.PRINTED)).status === 401 && (await A.signIn("olive@myshop.com", A.PRINTED)).status === 401);
  ok("…nor does it work sent with a request (no cookie)", (await A.users({ action: "me", key: A.PRINTED }, "")).status === 401 && (await A.users({ action: "me", key: NEW }, "")).status === 401);
  a = await A.signIn("OLIVE@myshop.com", NEW);
  ok("email and password sign in (the email in any case), with nothing left to do", a.status === 200 && a.body.pending === null && a.body.user.name === "Olive Owner" && a.body.user.email === "olive@myshop.com" && !!A.user("olive@myshop.com").lastLoginAt);
  const admin = a.cookie;
  ok("a wrong password, a wrong email, and no email are all the same refusal", (await A.signIn("olive@myshop.com", NEW + "x")).status === 401 && (await A.signIn("oliver@myshop.com", NEW)).status === 401 && (await A.signIn("", NEW)).status === 401 &&
    (await A.signIn("olive@myshop.com", "")).body.message === (await A.signIn("nobody@myshop.com", NEW)).body.message);
  ok("the session cookie is refused from another site", (await A.users({ action: "me" }, admin, { origin: "https://league.example.com" })).status === 403);

  console.log("\n=== A temporary password, and changing your own ===");
  a = await A.users({ action: "create", name: "Sam Staff", email: "sam@myshop.com", role: "staff" }, admin);
  const TEMP = a.body.temporaryPassword;
  ok("a new user gets a temporary password, shown once and not written to the audit log", a.status === 200 && /^([a-z2-9]{4}-){3}[a-z2-9]{4}$/.test(TEMP) && !JSON.stringify(A.d1.q("SELECT * FROM audit_log")).includes(TEMP) && A.audit("security.user_created").length === 1);
  let s = await A.signIn("sam@myshop.com", TEMP);
  ok("signing in with it leads to one thing only: choosing a new password", s.status === 200 && s.body.pending === "password" && (await A.twoFactor({ action: "status" }, s.cookie)).body.code === "setup_required" && (await A.password({ action: "status" }, s.cookie)).status === 200);
  const before = A.hits.length;
  ok("the current password has to be right, and a wrong one counts as a failed sign-in", (a = await A.password({ action: "change", current: "not-it-not-it", next: "sam picks this one" }, s.cookie)).status === 401 && A.hits.length === before + 1 && A.hits[before] === "admin_auth");
  ok("the new one can't be the old one", (await A.password({ action: "change", current: TEMP, next: TEMP }, s.cookie)).status === 400);
  a = await A.password({ action: "change", current: TEMP, next: "sam picks this one" }, s.cookie);
  ok("changing it signs that user out everywhere — and nobody else", a.status === 200 && a.cookie === "" && (await A.users({ action: "me" }, s.cookie)).status === 401 && (await A.users({ action: "me" }, admin)).status === 200);
  s = await A.signIn("sam@myshop.com", "sam picks this one");
  ok("the temporary password is dead and the new one signs in with nothing pending", (await A.signIn("sam@myshop.com", TEMP)).status === 401 && s.status === 200 && s.body.pending === null && s.body.user.role === "staff");
  ok("two users with the same password don't store the same thing", JSON.parse(A.user("sam@myshop.com").password).hash !== rec.hash && A.audit("security.password_changed").length === 1);
  ok("nobody can take an email that is in use", (await A.users({ action: "create", name: "Other", email: "SAM@myshop.com", role: "staff" }, admin)).status === 409);

  console.log("\n=== Locked out: replacing the secret ===");
  await A.twoFactor({ action: "activate", proposedSecret: SECRET, code: totpNow(SECRET) }, admin);   // the admin has two-step, and has lost the phone
  const REPRINTED = "2222-3333-4444-5555-6666-7777";
  A.env.PROXY_ADMIN_PASSPHRASE = REPRINTED;   // what `npm run setup -- --new-passphrase` does
  ok("every stored password stops working", (await A.signIn("olive@myshop.com", NEW)).status === 401 && (await A.signIn("sam@myshop.com", "sam picks this one")).status === 401 && (await A.signIn("", A.PRINTED)).status === 401);
  a = await A.signIn("whoever@example.com", REPRINTED);
  ok("the new passphrase gets the first admin back in — the same account, not a new one — without the lost authenticator", a.status === 200 && a.body.pending === "account" && a.body.user.email === "olive@myshop.com" && A.d1.q("SELECT count(*) n FROM users")[0].n === 2 &&
    A.user("olive@myshop.com").totpSecret === null);
  ok("…every session from before is gone, and it is in the audit log as a recovery", A.sessions() === 1 && (await A.users({ action: "me" }, s.cookie)).status === 401 && A.audit("security.recovery_signin").length === 1 && /"twoStepCleared":true/.test(A.audit("security.recovery_signin")[0].detail));
  ok("they must choose a password again, and can then see who else needs one", (await A.password({ action: "account", name: "Olive Owner", email: "olive@myshop.com" }, a.cookie)).status === 400 &&
    (await A.password({ action: "account", name: "Olive Owner", email: "olive@myshop.com", next: "third time lucky ok" }, a.cookie)).status === 200);
  const again = (await A.signIn("olive@myshop.com", "third time lucky ok")).cookie;
  const list = (await A.users({ action: "list" }, again)).body.users;
  ok("…the list marks the user whose password was voided", list.find(u => u.email === "sam@myshop.com").passwordUsable === false && list.find(u => u.email === "olive@myshop.com").passwordUsable === true);
  ok("the new passphrase is dead again once an admin has a password", (await A.signIn("", REPRINTED)).status === 401);

  console.log("\n=== An install from before there were users ===");
  // What the previous version left behind: one shared password and one shared two-step secret in
  // global_settings, no users. Built through every migration, as a real upgrade is.
  const old = await createD1();
  old._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) old.execFile(read("migrations/" + f));
  let B = await makeAuth({ d1: old });
  const legacy = await B.lib.passwordRecordFor_(B.env, "the owner's old password");
  old._raw.exec(`INSERT INTO global_settings (key, value) VALUES ('adminPassword', '${legacy}'), ('totpSecret', '${SECRET}'), ('totpLastCounter', '5')`);
  ok("the migration made the table and copied nothing", old.q("SELECT count(*) n FROM users")[0].n === 0 && old.q("PRAGMA table_info(admin_sessions)").some(c => c.name === "userId") && old.q("PRAGMA table_info(audit_log)").some(c => c.name === "targetUserId"));
  ok("the printed passphrase does not get in: the owner chose a password long ago", (await B.signIn("", B.PRINTED)).status === 401);
  a = await B.signIn("", "the owner's old password");
  ok("the old password works with no email, and still asks for the authenticator code", a.status === 200 && a.body.status === "totp_required");
  ok("…a wrong code is refused", (await B.signIn("", "the owner's old password", "000000")).status === 401);
  a = await B.signIn("the-owner@types.anything", "the owner's old password", totpNow(SECRET));
  ok("with the code they are in, as the one admin, active, with their two-step secret kept", a.status === 200 && old.q("SELECT role, status, totpSecret FROM users").map(u => u.role + u.status + u.totpSecret).join() === "adminactive" + SECRET);
  ok("…asked once for a name and an email, and nothing else", a.body.pending === "account" && (a = await B.password({ action: "account", name: "Pat Owner", email: "pat@myshop.com" }, a.cookie)).status === 200 && a.body.pending === null && B.sessions() === 1);
  ok("…the same code can't be used twice", (await B.signIn("pat@myshop.com", "the owner's old password", totpNow(SECRET))).status === 401);
  ok("the old settings rows are left where they were", old.q("SELECT count(*) n FROM global_settings WHERE key IN ('adminPassword','totpSecret')")[0].n === 2);

  // An owner who never chose a password but did turn on two-step: the passphrase must NOT clear it.
  B = await makeAuth();
  B.d1._raw.exec(`INSERT INTO global_settings (key, value) VALUES ('totpSecret', '${SECRET2}')`);
  ok("an owner still on the passphrase with two-step on is asked for the code, not let in without it", (a = await B.signIn("", B.PRINTED)).body.status === "totp_required" && (await B.users({ action: "me", key: B.PRINTED }, "")).status === 403);
  a = await B.signIn("", B.PRINTED, totpNow(SECRET2));
  ok("…and with it they are in, two-step still on", a.status === 200 && a.body.pending === "account" && B.d1.q("SELECT totpSecret FROM users")[0].totpSecret === SECRET2);
  // The oldest installs kept the secret in an environment variable.
  B = await makeAuth(); B.env.TOTP_SECRET = SECRET;
  ok("a two-step secret set as TOTP_SECRET by hand is carried across too", (await B.signIn("", B.PRINTED)).body.status === "totp_required" && (await B.signIn("", B.PRINTED, totpNow(SECRET))).status === 200 && B.d1.q("SELECT totpSecret FROM users")[0].totpSecret === SECRET);

  console.log("\n=== When the database misbehaves ===");
  B = await makeAuth();
  const bCookie = await B.firstAdmin();
  const real = B.d1.prepare.bind(B.d1), loud = console.error;
  console.error = () => {};   // the refusals below are logged; that is expected
  B.d1.prepare = (sql) => { if (/\busers\b/.test(sql)) throw new Error("D1 is down"); return real(sql); };
  ok("if users can't be read, sign-in is refused (503): an outage never brings the printed passphrase back", (await B.signIn("", B.PRINTED)).status === 503 && (await B.signIn("olive@myshop.com", "correct horse battery")).status === 503 && (await B.users({ action: "me", key: B.PRINTED }, "")).status === 503);
  ok("…and a session can't be checked, so it is refused too (503, not let through)", (await B.users({ action: "me" }, bCookie)).status === 503);
  B.d1.prepare = real; console.error = loud;
  B.d1._raw.exec(`UPDATE users SET password = '{"hash":"00","salt":"00112233445566778899aabbccddeeff","iterations":900000000,"mark":"x"}'`);
  const t0 = Date.now();
  ok("a record that isn't one (a billion iterations) is never computed: it just isn't a password", (await B.signIn("olive@myshop.com", "correct horse battery")).status === 401 && Date.now() - t0 < 2000);
  const noSecret = await makeAuth(); delete noSecret.env.PROXY_ADMIN_PASSPHRASE;
  ok("with no passphrase secret at all nobody signs in, whatever is typed", (await noSecret.signIn("", "")).status === 401 && (await noSecret.signIn("", "undefined")).status === 401);
  ok("sign-out works for anyone holding a cookie, and only removes that session", (await B.signOut(bCookie)).status === 200 && B.sessions() === 0);

  console.log(`\n${pass} passed, ${fail} failed`);
})().catch(e => { console.log("test114 crashed:", e); console.log("test114 crashed: false"); });
