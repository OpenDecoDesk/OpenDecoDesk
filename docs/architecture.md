# How it's built

A description of the code as it is, for someone who wants to change it or judge it. File names are
given so each statement can be checked.

## The pieces

OpenDecoDesk is **one Cloudflare Worker** (`src/worker.js`, configured by `wrangler.toml`) with:

- **Static assets** — everything in `public/`: one page (`index.html`) that is the storefront, and
  `admin.js`, the admin panel, loaded only on the admin address. Plain JavaScript, no framework and
  no build step. Only `public/` is ever served; nothing else in the repository is reachable.
- **An API** — `/api/<name>`, each one a file in `functions/api/`. The Worker only runs for
  `/api/*`; pages and pictures are served without it.
- **A D1 database** (SQLite) — the system of record for everything.
- **Three R2 buckets** — public pictures, private receipts, private design files.
- **A Durable Object** — a mailbox for the optional send-agent relay.
- **A cron trigger** — hourly, for the morning roll-up ([operations.md](operations.md)).

There is no other server, queue or cache service.

## How a request flows

1. A browser opens `https://league.myshop.com/`. Cloudflare serves `public/index.html` directly.
2. The page calls `GET /api/catalog` with **no shop named in the request**.
3. The Worker's router (`src/worker.js`, `ROUTES`) hands it to `functions/api/catalog.js`.
4. `catalog.js` loads the catalog (`functions/_lib/catalogCache.js`) and classifies the request's
   **hostname** (`functions/_lib/hostConfig.js`, `classifyHost`): the admin host, a shop
   (`locked` to one shop id), the root domain, or unknown.
5. It answers with that one shop's name, products and prices — or "admin", or an error for an
   address that isn't a shop. The page draws what it was told.
6. When the customer orders, the page posts to `/api/orders`. The server prices every line from
   the database itself, saves the order, and emails the confirmation after responding.

The admin works the same way on the admin host: `index.html` learns it is the admin, loads
`admin.js`, and every admin screen is a POST to `/api/orders` with an `action` name (the larger
upload and sign-in flows have their own endpoints).

### The catalog cache

Reading shops and products from the database on every page view would be wasteful, so
`getCatalogData(env)` caches the whole public catalog with the Cache API under a key that contains
a **version number** kept in the database. **Publish** adds one to the version, so every later
request uses a new key — nothing has to be purged. The version itself is held in memory for 30
seconds, and a cached catalog expires after 5 minutes regardless. If the database can't be read,
the last cached catalog is served.

Settings that the storefront needs (business profile, region, sales tax, feature switches) travel
in the same cached catalog, and saving them bumps the version, which is why they don't need Publish.

Orders are **not** priced from the cache's prices as shown in a browser: `priceItem()` in
`functions/_lib/db.js` prices each line on the server when the order is placed.

## The files

```
public/index.html         the storefront page, and the shell the admin loads into
public/admin.js           the admin panel (loaded only on the admin host)
public/_headers           security headers for every response
public/vendor/pdfjs/      Mozilla's pdf.js, vendored, for reading vendor invoices

src/worker.js             the Worker: routes /api/<name>, runs the hourly cron

functions/api/            one file per endpoint
  catalog.js                who am I, and what do I sell
  orders.js                 placing an order, and every admin action
  checkout.js               starts a Stripe Checkout for an order's balance
  stripe-webhook.js         payments, refunds, disputes and payouts from Stripe
  shipping.js               carrier rate quotes (signed)
  shippo-label.js           buying and reprinting shipping labels
  admin-session.js          sign-in and sign-out
  admin-2fa.js              setting up two-step sign-in
  upload.js                 picture uploads (admin)
  customer-design.js        a customer's own design, uploaded from the shop page
  invoice.js                a customer's invoice page: choosing delivery, paying (token-gated)
  receipt.js, design.js     private file uploads and signed download links
  verify.js, upload-verify.js   the customer's design-approval page
  image-proxy.js            fetches a stored picture for the admin's mockup editor
  daily-digest.js           the morning roll-up
  agent.js                  the send-agent relay

functions/_lib/           shared code
  db.js                     every database query, and all money arithmetic
  hostConfig.js             which host is this (admin / shop / root / unknown)
  catalogCache.js           the cached catalog
  adminAuth.js, access.js, totp.js   sign-in, sessions, Cloudflare Access, two-step codes
  rateLimit.js              rate limiting
  quoteToken.js             signed shipping quotes
  email.js                  every email
  catalogValidation.js      checks on shop and product fields
  fileUpload.js             size-capped reading and file-type checks
  imageInfo.js              an image's pixel size, read from its header
  customDomain.js           attaching a shop's hostname
  deliveryCheck.js          tracking lookups
  setupStatus.js            what is configured
  …

migrations/               every change to the database, in order
schema.sql                the whole database for a new install
scripts/setup.mjs         the installer
scripts/admin-local.js    the admin on your own computer against a throwaway database (`--sign-in` for the real sign-in)
test*.js, testlib/        the tests
```

## The data, in outline

About fifty tables (`schema.sql`). The main groups:

- **Shops and catalog** — `orgs`, `products`, `graphics`, `locations`, and the links from products
  to blanks and designs.
- **Orders** — `orders`, `order_items` (each line keeps the name, price and tax it was sold at),
  `order_payments` (the payments ledger), `shipping_labels`, `design_verifications`.
- **Inventory** — `blanks`, `blank_colors`, `blank_sizes`, `inventory_movements`; `transfers`,
  `transfer_movements`.
- **Production** — `threads`, `hoops`, `designs`, `design_versions`, `machines`, `production_runs`.
- **Bookkeeping** — `expenses`, `expense_categories`, `accounts`, `account_transfers`,
  `other_income`, `owner_transactions`, `statement_lines`, `statement_matches`, `reconciliations`,
  `closed_periods`.
- **Platform** — `global_settings`, `admin_sessions`, `rate_limits`, `audit_log`, `stripe_events`,
  `owner_notices`.

Rules the data keeps (see [CONTRIBUTING.md](../CONTRIBUTING.md) for how the code keeps them):

- **Money is whole cents**, in columns named `…Cents`. `db.js` is the only place that converts to
  and from dollars.
- **The payments ledger is the truth about "paid".** `orders.paid` is a cached answer, recomputed
  from the ledger after anything that changes what is owed or received. Refunds and lost disputes
  are negative rows.
- **Nothing financial is deleted.** An order, a payment or a stock movement entered by mistake is
  **voided** — kept, marked, and left out of every total.
- **A closed month is locked.** Once a month is closed, the admin can't make a change that would
  alter that month's numbers.
- **Stock changes are movements.** The quantity on hand is the sum of a blank's movements; the
  count stored on the blank is a cache of that sum.

## The security model

### Who can see what: the hostname decides

- The page ships **no shop data**. It asks the server who it is, and the server answers from the
  request's hostname — never from a shop id the browser sends. A visitor to one shop receives
  nothing about any other.
- The root domain serves no shop and ignores a `?org=` parameter, so shop ids can't be guessed
  there. An unrecognised hostname is refused, not treated as the root.
- Hostnames are matched exactly as `<label>.<root domain>`; a look-alike such as
  `admin.something-else.example` is "unknown".
- **Admin actions are only answered on the admin host** (`requireAdmin` in
  `functions/_lib/adminAuth.js`) — a valid sign-in sent to a shop's address is refused.

### Admin sign-in

- **Users.** Each person has their own account in the `users` table and signs in with an email
  and a password. A user is disabled, never deleted, so the audit log keeps their name; a
  disabled user's sessions stop working at once.
- **Three roles**, each including the one below: `staff` (shown as "Back office": orders,
  production, inventory, catalog content, expenses, reports), `manager` (also shops, publishing
  and the books) and `admin` (also users, the audit log and Global settings — a manager's
  requests may still read some of its values, but the page is an admin's). **One function enforces them**: `requireAdmin` in
  `functions/_lib/adminAuth.js` takes the lowest role allowed, and anything it isn't told is
  admin-only. `ACTION_ROLE` in `functions/api/orders.js` gives each of that endpoint's actions
  its role; a test fails if an action or an API file has none. The menu hides what a role can't
  use, but that is a convenience: the server is what refuses.
- **Passwords** are kept as salted hashes keyed with `PROXY_ADMIN_PASSPHRASE`, so a copy of the
  database alone can't be used to guess them. The stretching is light on purpose (a Worker gets
  very little CPU per request); the key is what protects them.
- **The installer's passphrase** (`PROXY_ADMIN_PASSPHRASE`) opens the admin only while no active
  admin has a usable password: on a new install, where it creates the first admin, and after the
  secret has been replaced to recover a locked-out install, which voids every stored password.
- **A session cookie.** Sign-in sets `__Host-odd_admin`: HttpOnly, Secure, SameSite=Strict, 24
  hours. The token is never returned to page JavaScript; the database stores only its SHA-256,
  with the user it belongs to. Requests using the cookie must also carry a same-origin `Origin`
  header.
- **Steps that come first.** A session can be *pending*: the user must finish setting up their
  account, replace a temporary password, or enrol in two-step sign-in. Until they have, the
  server answers nothing but the request that finishes that step.
- **Two-step sign-in (TOTP)** is each user's own, set up from Security → Security (2FA), with ten
  single-use recovery codes shown once. A code can't be used twice. While it is on it can't be
  replaced — it has to be turned off first, which needs a current code. An admin can require it
  for everyone (Users → Require two-step sign-in): nobody is signed out, and anyone without it
  must enrol at their next sign-in.
- **Optional Cloudflare Access** in front: when configured, every admin request must carry a valid
  Access token as well. It is an outer gate; who you are inside the app is still your own user.
- **It fails closed.** If the database can't be read, sign-in answers "unavailable" rather than
  letting anyone in or silently dropping the second step.
- **Failed sign-ins are counted** with their IP addresses and reported in the morning roll-up.
  Being refused for your role is not a failed sign-in and is not counted.

### What the server won't trust from a browser

- **Prices, names and weights** come from the database, not the request.
- **The order's time** is the server's.
- **Shipping cost** is only accepted as a **signed quote**: `/api/shipping` signs each rate (HMAC
  with `SIGNING_SECRET`) together with the shop, the ZIP, the cart contents and an expiry (two
  hours), and the order must present that token. A custom delivery option's fee is looked up in
  the shop's own list.
- **A line's quantity** is a whole number from 1 to 50, read by one rule for both the rate quote
  and the order, so the parcel that was weighed is the cart that is ordered. Anything else is
  refused, never rounded. A quoted cart is rebuilt from the catalog — the product's own weight
  and type — and a line the catalog doesn't have isn't quoted at all.
- **"Shipping — quote to follow"** is the server's decision: only a cart that fits no box may be
  placed without a carrier rate. That order reads "Quote pending" and can't go through card
  checkout until the shop has set its shipping.
- **A ship-to address** is kept only on an order shipped by carrier. Pickup and a shop's own
  delivery options have none, so an address sent with them is dropped and can't change the tax.
- **The amount charged by card** is the order's balance as the database has it.
- **The shop** on a shop's address is the hostname's shop, whatever the request says.
- **A US ship-to state must agree with the ZIP Code**, because the state decides sales tax.
- An order id must match a strict pattern, and a shop must exist, be marked ready, and not be past
  a hard deadline.

### Stripe

- A webhook is verified (HMAC-SHA256 with `STRIPE_WEBHOOK_SECRET`) before anything is recorded,
  and its timestamp must be within five minutes.
- It is safe to receive twice: processed event ids are remembered, and a Stripe payment's
  reference is unique in the ledger.
- Error details from Stripe are logged; a raw Stripe response object is never returned to a browser.

### Files

- **Pictures** (public bucket): admin only, the type checked against the file's first bytes, the
  size capped *while reading* (a large upload is cut off, not buffered), and the stored name
  generated by the server — a caller can't choose or overwrite one.
- **Receipts and design files** (private buckets): admin only. They are opened through a link that
  is signed and valid for 60 seconds. Receipts are type-checked; embroidery file formats have no
  reliable signature, so those rely on the size cap and on being admin-only.
- **Customer uploads on a design-approval page**: limited in number per link, type-checked, and
  the link itself expires 60 days after it was sent.
- **A customer's own design** (the shop page, before ordering): only on a shop's own address, for a
  product that takes one, behind the bot check. PNG, JPG or WebP checked against the first bytes,
  at most 10 MB, and a pixel size read from the header without decoding the image (at least 500 px
  on the long side, at most 10,000 px on a side). At most 2 GB is uploaded across the whole site in
  48 hours. Stored in the private bucket under a name the server generates; placing the order checks
  the upload belongs to that shop and product and is under 24 hours old.

### Rate limiting

`functions/_lib/rateLimit.js` counts requests per IP address per minute in the database: order
submission, card checkout and shipping quotes (20 a minute each), customers' design uploads (10),
and sign-in attempts (10). For
admin actions only **failed** credentials count, so a signed-in admin is never throttled. If the
database errors, counting falls back to memory rather than switching off.

### The audit log

Admin changes are written to `audit_log` with who did it (the user's email, never the session
token) and from which IP address. Security entries — sign-ins with the installer's passphrase,
password and two-step changes, everything done under Users, and the require-two-step switch —
also carry the ids of the user who did it and the user it was done to, and are written before
the change happens. Routine changes are logged
alongside the change. **Destructive or money-changing actions are logged first** — with the values
being replaced — **and refused if the log can't be written** (voiding an order or payment, a
refund, a discount, changing dates, voiding or restoring a stock movement, switching a feature).

### In the browser

- Everything a customer or admin typed is escaped before it is put into a page, and buttons carry
  their data in `data-` attributes rather than inside inline script.
- Image addresses are restricted to `https://` or a path on the site, when saved and again when
  served.
- Spreadsheet exports neutralise cells that start like a formula.
- `public/_headers` sets a Content Security Policy, `X-Frame-Options: DENY`, `nosniff`, a referrer
  policy, a permissions policy and HSTS on every response. **A known limit:** the policy allows
  inline scripts and styles (`'unsafe-inline'`), because the pages are written with inline
  handlers — so it is a second line of defence, not a guarantee against script injection. The
  HttpOnly session cookie is what keeps an injected script from stealing a reusable sign-in.
- The policy also lets the admin page talk to `http://127.0.0.1:8787`, for a send-agent running on
  the same computer.

### Secrets

Keys live in Cloudflare's secret store, never in the repository. `bash scripts/scan-private.sh`
looks for the common key formats and Cloudflare ids in the tracked files (not in history). The Setup status screen reports only whether a
secret is set.
