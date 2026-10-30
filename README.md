# OpenDecoDesk
Free, open-source shop software for embroidery and garment decoration businesses. Online ordering, order and production tracking, inventory, expenses with receipts, and accountant-ready year-end reports. Use the storefront or just the back office. Runs on your own Cloudflare account (free or $5/mo plan), deployed in a few clicks.

**Status: pre-release.** Everything specific to one shop is a setting. The installer (`npm run setup`) has
completed **one install on a real Cloudflare account, in its smallest form**: no file storage and
every optional service skipped. Its other paths (R2 buckets, Stripe, Shippo, email, Turnstile, Access,
automatic hostnames) have run only against a simulated `wrangler`. If you try it now you are an early tester: expect rough edges, start with
`npm run setup -- --dry-run`, and keep your own backups.

## What it is, and who it's for

OpenDecoDesk is for a small business that embroiders or prints garments — for clubs, teams, leagues,
schools, companies — and wants one place to take the orders and run the work, on an account it owns.

- **You sell to groups.** Each group ("shop") gets its own ordering page on its own address
  (`theirname.yourdomain.com`), with its own products, prices, deadline and delivery options. A visitor
  to one shop can't see that any other shop exists.
- **Or you don't sell online at all.** Turn the storefront off and use it as a back office: enter orders
  yourself, track them through production, keep the books.
- **You run it yourself.** It is one Cloudflare Worker with a database and file storage on your own
  Cloudflare account. There is no hosted version and nobody else holds your data.

It is not a general web-shop builder: there is no theme system, one currency (US dollars), English only,
and the tax and shipping features are built around a US business (see [Region](#region)).

## What it does

**Storefront**
- A storefront per shop, each on its own subdomain; a generic page everywhere else.
- Products with per-size or flat prices, colors, pictures, optional personalization, and configurable
  products (a graphic per location, priced in tiers).
- Customers can upload their own design for a product, printed as a transfer or digitized for
  embroidery, with an optional add-on price.
- Checkout by card (Stripe), Venmo, Zelle or check; local pickup, flat-fee delivery options, or carrier
  rates by ZIP (Shippo).
- Product categories you manage (the shop's sections and what each packs like), and products made
  with no blank.
- Versions of a product — short and long sleeve on one card with a toggle, each with its own sizes,
  prices, colors and blank — and copying products from one shop to another.
- An order deadline per shop, an optional bot check (Cloudflare Turnstile), and emailed confirmations.
- Publish per shop: edits stay a draft (with a signed preview link) until that shop is published.
- A guided setup for a new shop — one question per screen, products built from blanks — and a shop bar
  on every catalog screen.

**Orders and production**
- An Orders page per shop, and one across all shops: payments, discounts, refunds, line edits, stages
  from blanks ordered to delivered, packing and mailing labels, shipping labels and tracking.
- Local sales and orders entered by hand; payment links and invoices emailed to a customer (the
  invoice page lets them choose delivery and pay).
- Design approval: email a customer a proof, they approve or ask for changes from a link.
- Embroidery production: threads, hoops, designs and their stitch files, machines, a Run Order queue
  with timed runs, and a run-time report; stitch counts per run and machine maintenance by stitches or
  run hours.
- A morning email to the owner with new orders, payments, deliveries and anything that went wrong.

**Inventory and money**
- Blank garments and transfer sheets: receiving (with landed cost), stock by size and color, write-offs,
  and cost of goods sold worked out as orders are made. Blanks already on the shelf can be used for an
  order in one click, and the Blanks screen shows what's set aside for orders.
- Inventory in three groups: blanks for sale, blanks for testing or shop use, and finished stock —
  pieces made ahead for a shop, which fill its orders automatically. The Inventory & COGS report and
  the year-end export show each group, cost of goods by source and write-offs by reason.
- Accounts & money lists every blank and transfer-sheet purchase of the year, with its receipt.
- A "blanks to order" list by supplier, with reorder points and each vendor's free-shipping amount ("Get
  me to free shipping") and brand rules (restricted brands, the supplier's logo approval); CSV import for blanks and products; vendor-invoice PDF import.
- Blanks straight from a vendor: import complete blanks (colors, sizes, prices, photos) from SanMar's or
  S&S's product files, or live through PromoStandards; vendor prices kept apart from the average cost,
  with history and a 30-day reminder to check them; prices by color group (heathers, white); the
  vendor's minimum advertised price (MAP) read from its files and enforced on product prices; ordering
  blanks from a supplier through PromoStandards, with its shipment notices tracked.
- Embroidery files in any format, with previews of Tajima .dst and Barudan .dsb.
- Pricing awareness: under each price, what an item costs (blank, card fee, tax, transfers, supplies) and
  what it leaves, the hourly rate from its run time, and targets that flag products priced too low.
- Products that are embroidered and printed (fixed DTF transfers in the price), and mockups for any
  product, configurable or not.
- Expenses with receipts and tax categories, accounts and transfers, bank-statement import and
  reconciliation, closed months, and a year-end export for an accountant.
- An account viewer: one account's register with a running balance and a receipt on every row. A stock
  purchase shows as one charge, as on the statement, and its paying account can be changed for the whole
  receipt at once.
- Sales tax: one rate and home state, prices that include tax or tax added at checkout, exempt shops,
  and a sales-tax report.

**Running it**
- An admin panel on its own address, with a sign-in for each person, three roles (back office, manager, admin), two-step sign-in that can be required, and an audit log.
- [Feature switches](#feature-switches), so the parts you don't use are out of the way.

## The desktop version

For a shop that doesn't sell online: the back office as a program on one computer, for Windows and
Mac, with no Cloudflare account, no domain and no web shop. Email is optional, through your own
mailbox (Gmail, iCloud, your web host's mail). It is the same code, run by
Cloudflare's local runtime inside a desktop window, with the database and files in your user
folder. On first start it asks for your account, then opens Global settings for your business's
details; a default shop is there for the orders you enter. Backups, restoring one and getting back
in when locked out are in its menu. Early: see [docs/desktop.md](docs/desktop.md).

## Requirements

- A **Cloudflare account**. R2 (file storage) is optional: without it the installer carries on,
  and product pictures, receipts and design files can't be uploaded until you switch it on.
  Expect R2's checkout to ask for a payment method.
- A **domain whose DNS is on that Cloudflare account**.
- **Node.js 22 or newer** and git, on macOS or Linux (Windows is untried).
- Optional, each with its own account: Stripe (cards), Shippo (US shipping), Resend (email, if you
  don't use Cloudflare's). [docs/accounts-and-keys.md](docs/accounts-and-keys.md) walks through
  creating each account and finding each key.

## Quickstart

```bash
git clone <this repository> && cd opendecodesk
npm ci
npx wrangler login
npm run setup -- --dry-run     # see what it would do — changes nothing
npm run setup
```

Then follow the list it prints. The whole process, and the same steps by hand, are in
[docs/setup.md](docs/setup.md).

## What it costs

The software is free. What you pay for is Cloudflare, and whichever of Stripe, Shippo and Resend you use
(each has its own pricing; Stripe and Shippo charge per payment and per label).

- **It has been run on Cloudflare's paid Workers plan.** That is the only setup this code has actually
  been operated on. (The one-line description at the top of this page names the goal — a free or
  low-cost plan — not something that has been confirmed yet.)
- **Cloudflare's own email sending needs the paid Workers plan.** If you are not on it, use Resend for
  email instead ([docs/email.md](docs/email.md)).
- **Expect R2's checkout to ask for a payment method.** On the one account this was looked at,
  on the free Workers plan, the screen showed a free monthly allowance, nothing due up front, and
  charges only beyond the allowance. Cloudflare shows the current terms there before you agree.
  You can install without R2 and add it later.
- **Running it on Cloudflare's free plan is being evaluated and is not yet a supported claim.** Parts of
  the code were written with the free plan's limits in mind, but nobody has confirmed a whole install
  works within them. Don't plan a business around it until this section says otherwise.

For what the plans include and cost, see Cloudflare's pricing pages for Workers, D1 and R2 — this
README deliberately doesn't repeat numbers that change.

## Talking to embroidery machines

Sending designs to a machine, listing its files, copying files off it (Machine Files → Download, saved as
.DSB, several as a .zip) and finding machines on the network are done by a small
program that runs on a computer in the shop — the **send-agent**. It is a separate project (machine
protocols differ by maker, and are kept out of this repository), and it has not been published yet; this
code only contains the admin screens and the relay that talk to it. Everything else works without it.

## Feature switches

Five parts of the site are optional. Each has a switch in the admin under Tools → Global settings →
Features. **All five are on by default.** Turning one off hides its pages in the admin menu (opening one
of them directly shows a "this feature is turned off" page), and the server refuses its actions. Nothing
is deleted — every table and row stays — so turning it back on brings everything back as it was. Each
change is written to the audit log.

- **Storefront** — customers can browse shops and place orders online. Off: the install is back office
  only. Every shop address and the root domain show a short "Online ordering isn't available here." page
  (with the business name and contact email from the business profile, if set) — no products, no cart —
  and the server refuses a customer's order, card checkout and shipping-rate quote. Nothing in the admin
  is hidden: orders are entered there (Local sale), payment links and design proofs you email still work,
  and Publish, a shop's "ready" box and custom-domain setup keep working for when it is turned back on.
- **Production** — embroidery production: Threads (and needle settings), Hoops, Designs and their stitch
  files, Machines, Machine maintenance, Machine Files, Run Order, Abort reasons, the Run Times report and
  the send-agent relay.
  Off: orders are still moved through their stages by hand on the Orders page — including Mark
  manufactured, which uses up the blanks — no digitizing step or order-design upload is asked for, and the
  catalog health check stops flagging missing designs, hoops and stitch files.
- **Bookkeeping** — Expenses and receipts, Accounts & money (other income, owner money, transfers),
  Reconcile, the Account viewer, and Periods & Export (closing months, the accountant export). Off: the payments ledger on
  orders, the Revenue and Sales Tax reports and Stripe fee tracking stay. No month can be closed or
  reopened, but **months closed earlier stay locked**. Receiving blanks or a transfer sheet no longer asks
  what it was paid from, and can't record an R&D, written-off or personal part (those are an expense or an
  owner draw).
- **Shipping** — carrier shipping through Shippo: rate quotes at checkout, buying and reprinting labels,
  Package sizes, the ship-from address, the tracking checks in the morning roll-up and the "your order has
  shipped" email. Off: a shop's "Shipping" delivery option isn't offered (local pickup and the shop's own
  flat-fee options still are), and an order can still be marked shipped by hand. Carrier shipping also
  needs the country in Region to be `US`; either one being off turns it off. It can only be saved on
  with a Shippo key (`SHIPPO_API_KEY`) and a complete ship-from address (all but the name): Global
  settings shows the address as soon as Shipping is ticked, and saves nothing until both are there.
- **Design approval** — emailing a customer a design proof to approve, and the "Design approved" stage.
  Off: no order waits for an approval, the stage can't be set, and a link already emailed tells the
  customer that approval isn't available.

**Inventory is always on.** Stock of blanks and transfers, and cost of goods, are part of making an order
(marking it manufactured uses the blanks), so there is no switch for them in this release.

A change reaches every part of the site within about half a minute (the switches travel with the cached
catalog).

## Region

Set in the admin under Tools → Global settings → Region.

- **Time zone** — an IANA name such as `Europe/London` or `America/Chicago`. It decides the local hour
  the daily roll-up email arrives (`DIGEST_HOUR`, default 6) and the dates and times printed in emails.
  If it isn't set there, the `TIMEZONE` variable is used; if that isn't set either, UTC. The Worker's
  cron runs every hour and only the tick that is the roll-up's local hour does anything.
- **Country** — `US` (the default) or `OTHER`.
  - `US`: 5-digit ZIP (or ZIP+4), 2-letter state, a check that the ZIP belongs to the state, carrier
    rate quotes by ZIP and shipping labels.
  - `OTHER`: postal code and state / region are free text (trimmed and length-capped, not checked
    against each other), on the storefront, in the admin and for the ship-from address. Phone numbers
    are free text everywhere. **Not supported:** carrier rate quotes and shipping labels — a shop's
    "Shipping" delivery option is refused and hidden, so shops offer local pickup and their own
    flat-fee delivery options. Nothing else is localised: prices are in dollars, text is in English,
    dates are written the US way, and the tax reports keep their US layout.
- **Months in reports are UTC months.** The revenue, sales-tax and export reports, closed months and
  the "not in the future" check on dates you type all use the UTC calendar, whatever the time zone —
  an order placed late on the last evening of a month west of UTC lands in the next month.

## ZIP Codes and states

For a US install the site checks that a ship-to state agrees with its ZIP Code, from the ZIP's first
three digits. The table comes from USPS's "ZIP Locale Detail" list (the file dated 2026-10-01) and is
written into the code by `scripts/zip-prefix-table.py`; download the current file from
https://postalpro.usps.com/ZIP_Locale_Detail and run the script with `--write` to refresh it. The list
gives the state of the post office serving each ZIP, so the script adds the address states it can't show
(military AE / AA / AP, and a few towns served from across a state line). Any state listed for a prefix is
accepted, so the check catches a clearly wrong state, not every possible mismatch.

## Documentation

| | |
|---|---|
| [docs/setup.md](docs/setup.md) | Installing: the installer step by step, and the same steps by hand |
| [docs/accounts-and-keys.md](docs/accounts-and-keys.md) | Which accounts you need (Cloudflare, Stripe, Shippo, Resend, GitHub), creating each one, and where to find every key the installer asks for |
| [docs/configuration.md](docs/configuration.md) | Every setting, variable, secret and binding |
| [docs/shops-and-domains.md](docs/shops-and-domains.md) | The admin address, a shop per subdomain, adding a shop, Publish |
| [docs/email.md](docs/email.md) | Cloudflare email or Resend, verifying your domain, which inbox gets what |
| [docs/sales-tax.md](docs/sales-tax.md) | The rate and home state, prices with or without tax, what is taxed, the reports |
| [docs/operations.md](docs/operations.md) | The morning roll-up, backups and restoring, migrations, upgrading |
| [docs/desktop.md](docs/desktop.md) | The desktop version: what it leaves out, where its data is, backups, building it |
| [docs/architecture.md](docs/architecture.md) | How a request flows, the files, the data, the security model |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Running the tests, how they're written, the rules the code keeps |
| [SECURITY.md](SECURITY.md) | Reporting a vulnerability |

## Working on it

```bash
npm ci
npm test                               # every test file; a test fails if it prints "...: false"
bash scripts/scan-private.sh --strict  # no keys or account ids in the tree (nor your own private words, if you keep a list)
```

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

GNU Affero General Public License v3.0 — see [LICENSE](LICENSE). The bundled PDF reader in
`public/vendor/pdfjs/` is Mozilla's pdf.js, under the Apache License 2.0, and `public/admin-qr.js` is
Kazuhiko Arase's QR Code Generator, under the MIT license (see [NOTICE](NOTICE)).
