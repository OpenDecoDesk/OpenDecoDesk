# Shops and domains

## How addresses work

One install serves **one root domain**. Which page a visitor sees is decided by the address they
typed — the server reads the hostname of every request (`functions/_lib/hostConfig.js`).

| Address | What it is |
|---|---|
| `admin.myshop.com` | The admin panel. (`admin` is the default; `ADMIN_SUBDOMAIN` changes it.) |
| `league.myshop.com` | A shop — one per subdomain, each with its own products and settings. |
| `myshop.com`, `www.myshop.com` | The root domain: a generic page with your business name. No shop is shown here and no list of shops. |
| anything else | Refused. A mistyped subdomain is not quietly treated as the root. |

Three things follow from this:

- **A shop's customers can't discover your other shops.** The page they load contains no shop data
  at all; it asks the server "who am I?", and the server answers from the hostname with that one
  shop's name, products and prices. Nothing about any other shop is sent.
- **The admin only works on the admin address.** Admin requests are refused from a shop's address
  or the root domain, even with a valid sign-in.
- **Each hostname has to be attached to the Worker** before it loads. That is what the rest of this
  page is about.

The root domain does **not** have to point at OpenDecoDesk. If `myshop.com` is already your
business's website, leave it alone — only the admin and shop subdomains need to reach the Worker.

## The admin hostname

`npm run setup` adds your admin hostname to `wrangler.toml` as a **custom domain**:

```toml
routes = [
  { pattern = "admin.myshop.com", custom_domain = true },
]
```

With `custom_domain = true`, Cloudflare creates the DNS record and the certificate for that
hostname when the Worker is deployed. If the hostname **already has a DNS record**, the deploy is
refused — delete the old record in the Cloudflare dashboard first.

## Adding a shop

In the admin: **Manage catalog → ＋ New shop setup** (managers). A guided setup asks one question per
screen, with the steps down the side, and saves as it goes, so you can stop and resume (**Resume shop
setup**):

1. **Your shop:** its name — the shop ID and web address follow it — then decoration, delivery,
   payment, an order deadline and the shop's look. The web address is one word of lowercase letters
   and numbers; `www`, `api`, `images`, `mail`, `admin`, `all` and your own admin subdomain can't be
   used, nor one another shop has.
2. **Products:** pick blanks (or ＋ Enter a blank), then for each product its colors, decoration,
   designs, sizes and prices, and name and details.
3. **Check everything**, then **Go live** — the shop is ready and published.

Every catalog screen has the **shop bar** at the top: ← Manage catalog, the shop picker, Shop setup,
Shop settings (the shop's own form), Products, Designs and Graphics, and Publish. Products can also be
added later with **+ New Product**, **Import CSV** or **Copy from another shop…**. Attach the shop's
hostname (below).

Nothing here needs a code change. Attaching the hostname needs one `npm run deploy`, unless
automatic hostnames are set up.

## Publish

Each shop is published on its own. What shoppers see — and what orders are priced from — is the shop
as it was when it was last published: its settings and its products' rows (names, prices, sizes,
visibility, pictures). Edits in the admin are a **draft** until you press **Publish** for that shop
(Manage catalog or the shop's Products page, managers), or **Publish all shops**. A shop that has
never been published since this arrived is served live, as before.

- **Unpublished changes** are marked on Manage catalog and the Products page, product by product.
  **Discard changes…** on the shop bar (managers) puts the shop back to what was last published: its
  settings and products as they were, and a product added since removed (or hidden, if an order, a
  stock movement, an approval or a customer's upload already refers to it).
- **Preview** opens the shop's page with the draft, on the shop's own address, through a link signed
  with `SIGNING_SECRET` that works for an hour. Ordering is off in a preview.
- **Graphics, transfers, decoration locations, blank links and tier prices aren't part of the
  snapshot** — they apply as soon as they're saved.
- **These don't need Publish either**: the business profile, Region, Sales tax and the Feature
  switches.
- A product can't be saved without a price, and a new product starts hidden.

## Attaching a shop's hostname

### Automatically

If **Automatic hostnames for new shops** is set up (`CF_API_TOKEN`, `CF_ACCOUNT_ID`, `CF_ZONE_ID`,
`CF_WORKER_NAME` — the installer asks), creating a shop attaches `<subdomain>.<root domain>` to the
Worker as a custom domain. Cloudflare creates the DNS record and certificate.

- The result is shown when the shop is created and is written to the audit log. A failure never
  stops the shop from being created.
- The shop's **Edit** page has a **Custom domain** box showing the current state, with buttons to
  set it up or check again.
- A hostname that **already has a DNS record** is refused rather than overwritten — remove the
  record first.
- Changing a shop's subdomain later does **not** remove the old hostname; set up the new one from
  the Edit page and remove the old one in the Cloudflare dashboard.

**The API token.** It needs permission to edit Workers scripts on the account, to edit Workers
routes on the zone, and to read the zone's DNS (this is what `functions/_lib/customDomain.js`
documents; the exact permission names are Cloudflare's and may change). It is the most powerful
secret the site holds: it is only used by the admin's create-shop and set-up-domain actions and is
never sent to a browser, but create it for this one zone, with nothing more than it needs.

### By hand

After creating the shop in the admin, run:

```bash
npm run deploy
```

It reads every shop from the database, adds a line for each to the hostnames block the installer
wrote in `wrangler.toml`, and deploys. Cloudflare then creates the DNS record and certificate; a
hostname attached for the first time can take a few minutes to start answering.

```toml
routes = [
  { pattern = "admin.myshop.com", custom_domain = true },
  { pattern = "league.myshop.com", custom_domain = true },
]
```

> **Always deploy with `npm run deploy`, not a bare `npx wrangler deploy`.** A deploy makes the
> Worker's hostnames exactly the ones listed in `wrangler.toml`. A hostname attached any other
> way — in the Cloudflare dashboard (the Worker → Settings → Domains & Routes), or by the admin
> when a shop was created — is **detached by the next deploy**, with its DNS record, and the shop
> stops loading. This was seen on a real install. `npm run deploy` lists every shop first, so
> nothing is dropped; `npm run setup` does the same when it is run again.
>
> If a shop went offline this way, run `npm run deploy`. The hostname is attached again; give it
> a few minutes, since the address was briefly gone and computers remember that for a while.

## Turning the storefront off

With **Global settings → Features → Storefront** off, every shop address and the root domain show
"Online ordering isn't available here." and the server takes no customer orders. Shops, products,
"ready", Publish and hostnames all still work in the admin, ready for when it is turned back on.
An invoice you've sent (below) still works: its link opens card payment and shipping rates for
that one order.

## A shop's own settings

Manage catalog → the shop → **Edit**:

- **Delivery & pickup** — the list customers choose from: local pickup, carrier shipping (US, with
  the Shipping feature), and any number of your own options with a flat fee.
- **Payment methods** — a shop can turn off methods that are on site-wide; it can't turn on one
  that is off site-wide.
- **Order deadline** — a date, a message for afterwards, and whether orders are still accepted
  after it.
- **Sales tax** — tax exemption (see [sales-tax.md](sales-tax.md)).
- **Reorder QR code & option prices** — for configurable products.

## Product categories

A product's category (Tools → **Product categories**) decides which section of the shop's page it is
listed under, in the order set there, and what it packs like when a box is chosen for shipping (a
shirt, a sweatshirt, a cap, or "other" — no automatic box, the shipping is quoted by hand). The list
starts with Shirt, Sweatshirt, Cap, T Shirt, Hoodie, Patch and Other, and is yours to change. A category
in use by a product or a blank can't be deleted. Whether a product has sizes doesn't depend on its
category: it follows the product's pricing (by size, or one flat price).

On Manage catalog → the shop → **Products** the list is drawn the way the shop's page is, a section per
category, and ↑ ↓ move a product within its section (Publish to show the new order). On a configurable
product, the colors offered can be put in order too (↑ ↓ / First under the color boxes): that is the
order customers see the swatches in, and the first one is shown when the product opens.

## The product form

A product's page is a set of cards: Basics, **What does the customer choose?**, Blank & colors, On
every piece, The customer's pick, Customer's own design, Personalization, Prices & costs, and Pictures &
shop page. The first question has three answers: **Nothing** (every piece is the same), **A color**, or
**A color and a graphic** (the customer picks a graphic at one or more decoration locations). The page
then shows only the cards that kind of product uses.

The designs under **On every piece** are stitched on every piece, *as well as* the graphic the customer
picks, then the pick, then any personalization. Under the question, **What Run Order will do** lists
those hoopings as last saved, worked out by the same code Run Order uses, so a pick that can't be run
shows here first.

The catalog check also warns about settings that contradict each other:
- designs stitched on top of the customer's pick;
- a mockup graphic that repeats a pick, or that nothing stitches;
- **No embroidery design needed** or **No blank needed** ticked on a product that has designs or blank
  links;
- a pick list with personalization off;
- graphic options on a product that isn't configurable.

Each problem is outlined in the card that fixes it. An open order line placed before such a change is
marked **Check line — doesn't match catalog** on the Orders page; Edit items → **Update from catalog**
brings it up to date. With the Production feature off, the stitching parts (designs, What Run Order
will do, and their warnings) are left out.

## Versions of a product

A shirt sold in short and long sleeve is two products shown as **one card** on the shop page, with a
toggle between them. On the product form, **Versions** → **Add a version (e.g. long sleeve)…** makes
the second one: a new product, hidden until you tick Visible, with the first one's shared settings
(name, description, category, features, personalization, the customer's own design, No blank needed,
configurable locations, designs). Each version keeps its own sizes and prices, weight, colors,
pictures, overlay mockups and blank links, so give the new one its own blank. **Copy settings** brings
the shared settings across again after you change them on the other version; **Separate** makes them
two ordinary products.

Order lines are named with the version — "Club Tee (Long sleeve)". Both versions must be in the same
category (the card sits in one section); the catalog check warns when they aren't. The Products list
keeps them together, the second one indented.

## Copying products from another shop

Manage catalog → the shop → Products → **Copy from another shop…**: pick the shop, tick its products,
and set each copy's ID, name, subtitle, category, version name and whether it's visible. A copy takes
the product's prices and sizes, weight, features, personalization, colors, locations (with their upload
prices), settings and blank links, and its pictures if you tick that. It never takes overlay mockups or
ready-to-ship stock. Graphics and designs belong to a shop: each one is matched to this shop's graphic
or design of the same name, or left out, and the result lists which — except a **global** graphic or
design, which every shop can use, so the copy keeps it. Versions of a product are copied together. Nothing is copied unless every copy is valid. A new shop's "copy products from" does the
same.

## Global graphics

A graphic can be made **Global** (the graphic form's Global box): every shop can offer it, and it's kept
in one place with its home shop, like a global design. A global graphic can only link a global design
and a transfer open to every shop, and it can't be made shop-only again while another shop's products
use it. The Graphics list shows them under "🌐 Global — every shop", and graphic pickers mark them 🌐.

## Products without a blank

Linking a product to a blank (Blank links on the product) is optional. Without one the product
saves and sells as usual; the catalog check marks it in amber, because its stock and cost of goods
aren't tracked. A configurable product's colors normally come from the blanks ticked for it — with
no blank, type the colors in by name instead.

A product that is made with **no blank at all** — a patch cut from twill on hand — gets **No blank
needed** on the product form. Its order lines then skip Blank ordered / received, go to Run Order once
paid (and the design is ready), stay off Blanks to Order, and the catalog check stops asking for a
blank link. Record its materials under Expenses as supplies.

## Blanks from stock

Blanks come out of stock when an order's pieces are made, not when they're received. An order whose
blanks are already on the shelf shows **In stock** on Run Order's "Paid, not yet run" list, with **Use
from stock**; on the Orders page the stage menu has **Use blanks from stock**. Either marks the order's
blanks ordered and received from "In stock" in one go. Stock is offered to orders soonest due first,
and only when it covers the whole order; otherwise you're told what's short, and nothing changes.

The Blanks screen shows, next to what's on hand, how many are **set aside**: promised to orders whose
blanks are in but not made yet. The shop page and the Products list show how many of a product's blank
are on the shelf for the color and size picked ("N ready to decorate") — what's on hand less what's set
aside. It's only a count: nothing is held for the customer. Finished stock ("N in stock") is shown
instead when there is some.

**Run Transfer Sheets** knows what's on the shelf too: a line whose transfers were already used, were
marked received, or are covered by transfer stock is ready to press, and the card says which (or what's
short). Stock is shared out soonest due first, and the gang sheet counts only what still has to be
printed. An order that has shipped, been delivered or been completed drops off the run pages and stops
holding blanks, even if it was never marked made. Blanks are received with **Receive order** (or Import from PDF), so
every receipt is against a vendor order.

## Blanks from vendors, and their prices

**Vendor prices** are kept apart from what your stock cost. On a blank's form each color and size has a
**Vendor price** (what the vendor charges now) beside a read-only average cost (what what's on the shelf
cost, landed). Typing a new vendor price never rewrites the average. **Same for all colors**, **Prices
are current**, **Price history…** and **Re-work average cost** are there too. When a vendor price
changes, every product priced on that blank is flagged (the catalog check, and on the product) until
you update its prices or click **Prices still OK**. Every 30 days the morning roll-up and Communications
list the blanks on products for sale whose prices haven't been checked.

**Blanks from a vendor's file:** Blanks → **Import → Vendor product file — new blanks…** (or **— update
prices…**) reads SanMar's product file (SDL CSV) or S&S's Data Library (Products + Styles .xlsx).
Pick the styles; each comes up for review — colors, sizes, prices per color, description, features and
photos (from a folder of the vendor's images on your computer, or downloaded from the vendor) — and
nothing changes until **Create / apply**. An update only takes what you tick, and never touches stock
or average cost. On a product, **Copy from blank** brings in the blank's description and features.

**Live from a vendor (PromoStandards):** Tools → **Vendor integrations** (admins) connects suppliers
that offer PromoStandards web services, with a login the vendor gives you, stored encrypted (it needs
the `VENDOR_CREDENTIALS_KEY` secret — see [accounts-and-keys.md](accounts-and-keys.md)). Then Blanks →
**Connected vendor → Refresh prices and colors…** and **Look up a style → new blank…** bring live data
into the same review. (The Connected vendor menu appears on Blanks only once a vendor is connected.)
A blank made or updated from a connection stays linked to it. Each connection's **Logs…** (admins) lists
every call to the vendor's web services — when, what, the answer or the vendor's error, how long — with
the full request (the password blanked) and response; logs are kept 30 days. A picture a vendor repeats on
every color (a catalog shot) isn't taken as any one color's, and SanMar's parts each bring their own color.

**Ordering blanks from a supplier** (admins): on Blanks to Order, a supplier whose connection offers
PromoStandards Purchase Order gets **Order from <supplier>…**. The window checks each line's part and
the supplier's stock, then places the order, shipped to your ship-from address (Global settings →
Ship-from), and marks the order lines "blanks ordered" with the PO number. PO numbers start with the
Business profile's **Purchase order prefix** (blank = `PO`), then the date. The supplier's shipment
notices become blank shipments — in the morning roll-up and on **Check shipments** — and **Receive…**
fills in Receive order. A line whose blank isn't linked to a connection is named under the table.
Suppliers turn ordering on separately (SanMar after a test order on its test service), and it charges
the payment method the supplier has on file for you — S&S needs an **integration payment method** (card
or bank) in your S&S account settings first. **A supplier's test service isn't a promise**: one has
placed a real order. On a test connection the PO number starts `TEST-` and the order says "TEST ORDER —
DO NOT PROCESS OR SHIP", but a supplier's system may ignore both, so check with the supplier. **Mark
cancelled…** records an order you cancelled with the supplier (it doesn't contact them): its lines that
haven't shipped or arrived go back on Blanks to Order, and its shipments stop being checked.

**Brand rules:** some brands may only be resold on the supplier's terms — most only decorated, and a
large order (100 pieces of one style by default) only after the supplier approves the logo. Tools →
**Brand rules** (managers read it, admins change it) starts with the brands SanMar and S&S publish as
restricted — verify each with the supplier you buy it from — and per brand sets the large quantity,
whether it must be decorated (with categories that may be sold plain), whether a large order needs
approval, a note, and the logo concerns. A product on such a brand is flagged by the catalog check, an
order with a large quantity of one style gets a **Supplier review** pill, and Blanks to Order marks it.
**Price rule:** Brand rules also sets a price over MAP — dollars or percent, generally and per brand.
The setup wizard and the product form's **Work out the prices from the blank's cost or MAP…** start a
blank with a MAP at that price, and a price under the rule (but not under MAP) is a warning on the
Pricing panel, Price analysis, the Products list and the catalog check. **Show price impact…** lists
every product price on a blank with a MAP, in every shop — before, after the rule, and the change — and
a manager can apply the ticked prices (then Publish each shop).
A manager records the supplier's approval on the product's form, with the supplier's reply attached;
**Order from <supplier>…** refuses a large quantity without one unless an admin gives a reason
(audited).

**Reorder points and free shipping:** a supplier charges marked-up freight on a small order, so keep
the blanks you sell most in stock and top each order up to the free-shipping amount. The blank form's
**Keep** column is a reorder point per color and size ("keep at least N" not set aside); Blanks shows
a chip and a **Below reorder point** filter, and Blanks to Order adds the restock under each row's
count, with an **Include restock** box — change a row's restock or leave it out (✕), and ↺ puts the
suggestion back. Restock you've already ordered (from the Order window, or **Mark as ordered**) isn't
suggested again until it arrives. Each vendor's free shipping — a dollar amount or a piece count — is
set on its Blanks to Order block or in Global settings → **Vendor free shipping**; SanMar and S&S
start at their published $200. **Get me to free shipping** fills an order up to it: reorder
shortfalls first, then your best sellers (by the last 90 and 365 days), plus anything you add — then
Copy / CSV, Mark as ordered, or continue to the Order window.

**MAP (minimum advertised price):** S&S's files (`MAPPrice`; $0.01 means none) and SanMar's
(`MAP_PRICING`) carry each size's MAP, and it can be typed on the blank's form. A product's price for a
size can't be below the MAP of the blank sizes it's linked to (the highest across a color group's
colors): saving such a price is refused, and so is a link that would cause it. A product left below a
MAP that rose later is a catalog error, flagged in Price analysis, on the Products list (**⚠ Below
MAP**) and in the morning roll-up. PromoStandards has no MAP, so a refresh from it leaves MAP alone.
MAP is the vendor's public price, so staff see these warnings too.

**Color price groups:** a configurable product's colors can be grouped, each group with its own price
per size — heathers dearer, white cheaper (the product form's **Color price groups**, with **Suggest
from blank prices**). A color in no group keeps the product's own price.

**Weights:** each color and size of a blank can have a weight (the blank form's Weight column, filled
in from S&S's and SanMar's product files and from PromoStandards). Shipping quotes and package
weights use it for every product linked to that size; a weight typed on the product overrides it.

**Importing a vendor's invoice PDF:** a line for a color or size the blank doesn't have yet is added to
the blank (nothing in stock, no cost) instead of being left out.

**Embroidery files** in any format are accepted as a design's files; a known stitch format can't be the
editable design file and a known project format can't be the machine file. Tajima `.dst` and Barudan
`.dsb` files get needle stops and previews.

## Pricing: what an item costs and leaves

Managers see, on a product's form, what each item costs the shop under its price and what's left:
the blank (its vendor price, else the average cost), the card fee, sales tax, transfers (the reorder QR,
printed transfers and the product's own **DTF / transfer cost per item**) and **Shop supplies per
item**. Give it a **Run time** and it shows the hourly rate too (or the average of its timed runs on
Run Order). When sales tax is added on top of your prices, the tax isn't a cost; the card fee is then
on the price plus the tax.

Global settings → **Pricing** sets the card fee, the default supplies cost and two optional targets —
**Target income per item** and **Target effective hourly rate**. Meeting either target is enough: a price
is below target only when it misses every one that applies (the hourly one needs a run time). Such a product is flagged
on its form, on the Products list, in **Price analysis** (on Manage catalog and the Products list) and
by the catalog check, and the morning roll-up lists products that slip below one (a blank's cost, a fee
or a target changed). Staff can edit products but don't see costs and margins.

## Printed transfers and mockups

A product can carry **Printed transfers (DTF)** at fixed locations — a crest on the back of an
embroidered shirt. They're part of its price; the customer doesn't choose them. Every order line gets
them, so Run Transfer Sheets, transfer stock and cost of goods handle them like the reorder QR.

Mockups work for any product, not only configurable ones: the product form has a mockup table per
location, with the graphics offered there and its printed transfers. A plain product's embroidery comes
from its designs, which have no location, so **Embroidered graphics (for mockups)** names the
embroidery graphic to picture at each location — for pictures only, never the order or the price.

## Finished stock

Pieces made ahead — a shop's caps already embroidered and on the shelf — are **finished stock**. On
Manage catalog → the shop → Products, a product's **Stock** button opens its stock window:

- **Make for stock** takes the linked blanks out of blank stock at their cost and adds the finished
  pieces at that cost. It isn't cost of goods yet; that's counted when a piece is sold.
- **Correct count** sets the number on hand after a count. A product made with no blank (a patch) has
  no blanks to take out, so its count is entered this way.
- **History** lists every change, and each can be voided (a Make for stock entry puts its blanks back).
  Entries in a closed month can't be changed.

An order from the shop page, or a local sale, for a size that's in stock is **filled from stock**
automatically: it skips the blank, design and making steps, and the order lines say "From stock". The
pieces are set aside until the order is marked made (a local sale is handed over, so at once), then
leave stock with their cost. Cancelling or voiding before it ships puts them back, and two orders can't
both get the last piece. A product with color and graphic choices, a personalized line, or one with
the customer's own design is always made, never taken from stock. Each version of a product has its
own stock.

Blanks bought for testing or shop use are marked **For testing / shop use** on the blank (TESTING on
the Blanks screen); they're used up with Write off → testing. Every write-off records why: testing,
damaged, lost or other. Reports → **Inventory & COGS** shows the three groups — blanks for sale, blanks
for testing, finished stock — with cost of goods split into blanks used on orders and finished stock
sold, write-offs by reason, and a roll-forward that says whether it adds up. Periods & Export's
year-end files carry the same figures, with an "Inventory by group" file.

## Invoices

Orders → **Send invoice…** (on any order that still owes), or "Email the customer an invoice" on the
Local sale form, emails the customer a link to an invoice page on the shop's own address. On it they
see the lines and what's owed, choose how they'll get the order — the shop's pickup and delivery
options, or carrier rates for their address — and pay by card, or see how to pay by Venmo, Zelle or
check (from Global settings → Business profile). Their delivery choice is written to the order: the fee
comes from the shop's list or a signed carrier rate, never from the page, and the sales tax follows the
address. "Shipping — cost to follow" is only offered when no box fits the order. The choice can't be
changed once the order is paid, shipped or in a closed month, or when the invoice was sent with the
delivery fixed. Sending again keeps the same link and renews it for 60 days; the customer's choice is
in the morning roll-up.

## Customers' own designs

A product can let the customer upload their own artwork (Manage catalog → the product → **Customer's
own design**):

- **Embroidery** — you digitize the customer's image and upload the stitch file for that line (Orders
  → Edit items → Files → Order design) before Digitizing complete. The customer approves the proof
  as for a typed-in name, and Run Order runs the stitch file you uploaded.
- **Transfer** — the line goes to Run Transfer Sheets with the customer's image, printed as uploaded.
- **Add-on per piece** — added to the price, like a graphic's add-on. Blank means free. A
  configurable product can set its own add-on at each location (under the location, in the product's
  graphics); a location left blank uses the product's.

On an ordinary product with no design of its own the upload is **required** (and the catalog check
doesn't flag the product for having no design). On one with a design the customer can choose
**Use my own design instead**, which replaces that design on that item. A configurable product
offers **Custom — upload your own** at each location, and the customer can use it at as many
locations as they like. Stitched, each of those locations gets its own order design: Files shows
an **Order design** slot per location, and each one's hooping on Run Order waits for its stitch file.

What the shop page accepts: PNG, JPG or WebP, up to 10 MB, at least 500 px on the long side and at
most 10,000 px on either side. A transfer under 1,500 px gets a warning that it may print soft. The
server checks all of this again. Uploads go to the private `DESIGNS` bucket (see
[configuration.md](configuration.md)), so the setting needs file storage. An upload that never
made it onto an order is deleted after 48 hours.

The customer's file is on the order line under **Files**, with a picture; it can be downloaded but
not deleted. Adding a customer's design from the admin (Edit items, a local sale) isn't offered:
attach the file under Files instead.
