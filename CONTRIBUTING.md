# Contributing

Thanks for looking. This codebase grew for a long time before it was opened up, so it
has habits. Following them matters more here than in most projects, because a lot of the safety
comes from doing the same thing the same way everywhere.

## Getting set up

```bash
npm ci
npm test                                 # every test; takes a few minutes
bash scripts/scan-private.sh --strict    # must exit 0
```

You don't need a Cloudflare account to work on it. The tests run the real code against a real
SQLite database in memory (`sql.js`) and the real pages in `jsdom`.

To click around the admin on your own computer:

```bash
node scripts/admin-local.js     # then open http://localhost:8790
```

It runs the admin against a throwaway database built from the real migrations, with sign-in
stubbed out. Add `--sign-in` to get the real sign-in, users and roles instead (it prints the
passphrase for the first sign-in). One empty shop; uploads, Stripe, Shippo and email aren't wired; everything is gone
when you stop it. (The real site decides "am I the admin?" from the hostname, which is why
`wrangler dev` on localhost only ever shows the generic page.)

Run one test with `node test107_storefront_switch.js`.

After editing `public/admin.js`, check it still parses as a classic script:

```bash
node -e "new Function(require('fs').readFileSync('public/admin.js','utf8'))"
```

## How the tests work

There is no test framework. Each `test*.js` file is a plain Node script.

### A test passes or fails by what it prints

A check is a line `description: true` or `description: false`:

```js
const ok = (d, c) => { console.log(d + ":", !!c); };
ok("a new install has it on", (await lib.getFeatures(d1)).storefront === true);
```

`run-tests.sh` runs every `test*.js` and **fails if a file exits non-zero or prints any line ending
in `: false`.** So:

- A check that prints `false` fails the build even though nothing threw.
- Never print a line ending `: false` for any other reason (a log message, a dumped value).
- A check must be able to fail. Read the description as a sentence and make sure the condition
  really tests it. Avoid `|| true`, and avoid conditions that pass when the thing is missing.
- Write the description as the behaviour in plain words — the output of a test file should read
  like a specification.

### The source files are glued together, with imports removed

Cloudflare's runtime isn't available in Node, so a test loads the real source like this:

```js
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "")
                          .replace(/export (async function|function|const)/g, "$1");
const api = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + stubs + "\n" +
  strip(read("functions/_lib/db.js")) + "\n" + strip(read("functions/api/orders.js")) +
  "\nreturn onRequestPost;")();
```

Every file's contents end up in **one scope**. That has consequences for the code you write in
`functions/`:

- **Use only `export function`, `export async function` and `export const`.** `export default`,
  `export { a, b }`, `export class` and `export let` are not stripped and will break every test
  that loads the file. Imports must be the `import { … } from "…"` form — a namespace import
  (`import * as x`) or a default import is not stripped. (`src/worker.js` is the exception: it is
  the real module entry point, and tests import it properly.)
- **Top-level names must be unique across files.** Two files that both declare
  `const MAX_BYTES` can't be loaded into the same test. Give module-level helpers distinctive
  names; the convention is a trailing underscore for private helpers (`cashoutNetCents_`).
- **A new import can break tests you didn't touch.** If `orders.js` starts calling a function from
  a new file, every test that glues `orders.js` together without that file gets a `ReferenceError`
  — but only when the new code path actually runs. If your new function is called on a common
  path, either put it in a file the harnesses already include (most include `db.js`,
  `hostConfig.js` and `http.js`) or update the harnesses. A small file with **no imports of its
  own** is the easiest thing for a test to add.
- **Some tests replace functions one at a time** (a stub declared before the real source, or the
  real source declared after a stub). Renaming or re-ordering a function can change which one wins.
- The regex only strips an import whose braces close before `from`. Keep imports in that shape.

`testlib/d1-shim.js` gives tests a database with the same interface as D1
(`prepare().bind().first()/all()/run()`, `batch()`), and it is strict about the things D1 is strict
about — binding `undefined` throws. `testlib/mail-mock.js` captures email.

### What to test

Test behaviour through the real handler wherever you can: post the request an admin's browser
would send and look at the database afterwards. When you add an admin action, also add it to the
list in `test106_features.js` ("No action can be forgotten") — that test fails for any action that
is neither behind a feature switch nor on its always-on list.

## The rules the code keeps

### Database changes are migrations — and `schema.sql` follows

- Every change to the database is a **new** file `migrations/NNNN_description.sql`. Never edit one
  that has been released.
- Make the **same** change in `schema.sql`, which builds a new install in one go. `test33` fails
  if `schema.sql` and "all the migrations applied" ever differ.
- Prefer additive changes (a new nullable column, a new table). A migration that rebuilds a table
  must rename the old tables first, parent last, so dropping them can't cascade — see the header
  of `migrations/0006_ledger_integrity.sql`.
- Code must tolerate running briefly against a database that hasn't had the newest migration
  (deploys and migrations aren't atomic). Several readers already catch "no such column".

### Money is whole cents, and `db.js` is the only converter

- Money is stored as INTEGER cents in columns named `…Cents`.
- Handlers and pages pass and receive dollars; **`functions/_lib/db.js` is the only place that
  converts** (`toCents` / `fromCents`). Don't multiply by 100 anywhere else.
- Add money in cents. Never sum floating-point dollars.
- "Is it paid?" is always computed from the payments ledger (`refreshPaidStatus`). Never set
  `orders.paid` directly. What an order comes to is `orderAmounts()` — don't re-derive it.
- Sales tax is worked out once per line, by `splitTaxInclusive` / `addTaxExclusive`. Don't write
  another formula.

### Dates

An unset date is `NULL`, never an empty string. Test with `IS NULL`.

### Nothing financial is hard-deleted

Orders, payments, expenses and stock movements are **voided** or soft-deleted, and every report
filters them out. If you add a report, exclude voided and test orders
(`o.isTest = 0 AND o.voidedAt IS NULL`).

### Destructive actions are audited first

For an action that removes or rewrites something that matters — a void, a refund, a discount, a
date change, a setting that takes features away — write the audit row **before** the change, with
the values being replaced, and **refuse the action if the audit row can't be written**:

```js
const auditErr = await auditStrict({ orgId, orderId, action: "order.voided", detail: { before } });
if (auditErr) return auditErr;       // 503 — nothing was changed
await voidOrder(env.DB, orderId, reason);
```

Routine changes use `audit(...)`, which is written alongside. Either way, record what changed
(`{ field: { from, to } }`), never a secret.

### Closed months

An admin write that could change a closed month's numbers must go through `periodGuard()` in
`orders.js`.

### Admin actions

- Check the caller with `requireAdmin(env, host, body.key, request, …)` before anything else.
- If the action belongs to an optional feature, add it to `FEATURE_ACTIONS` in `orders.js`.
- Validate on the server. The browser's checks are a convenience.
- Error messages a customer can see must be written for a customer. Internal error text is
  logged, not returned.

### In the page

- Escape everything that came from a person or the database with `escapeHtml()` before it goes
  into HTML.
- Don't build an inline `onclick="…"` string out of data. Put the values in `data-` attributes
  and read `this.dataset`.
- A pop-up closes from a button or Escape, never from a click outside it (a test guards this).
- `public/admin.js` and the script in `index.html` are classic scripts sharing one global scope;
  there is no bundler.

## Style

Match what's around you.

- Plain JavaScript, no dependencies added without a very good reason, no build step.
- Comments explain **why**, and what would go wrong otherwise. Write them for the next person who
  has never seen this code before.
- Plain language in everything a user reads. The people using this run small shops.
- Keep business-specific things out: no real names, domains or addresses, not even in tests or
  comments. `scripts/scan-private.sh --strict` must stay clean. (It checks for keys and account ids;
  to have it check for your own private words too, see `scripts/scan-private.words.example`.)
- Small commits, each passing `npm test`.

## Documentation

If you change behaviour that `README.md` or `docs/` describes, change them in the same commit.
Only write down what the code does — if you haven't checked it, don't claim it.

## Licence

Contributions are accepted under the project's licence, AGPL-3.0 (see `LICENSE`).
