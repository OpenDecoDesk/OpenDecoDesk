# The desktop version

The back office as a program on one computer, for a shop that doesn't sell online and doesn't need
email: no Cloudflare account, no domain, no web shop. You download it, open it, and it asks for your
name, email and a password, then your business's details. After that you have orders entered by
hand, production, inventory and cost of goods, and the books.

**Status: early.** The code is the same as a cloud install's, and the desktop parts have been run on
Linux in testing (the program itself, a first start, backups, restoring one, getting back in after
being locked out). The Windows and Mac downloads are built by GitHub Actions
(`.github/workflows/desktop.yml`), but nobody has run those builds on a real Windows PC or Mac yet.
Keep backups.

## What it is

The same Worker (`src/worker.js`) and the same pages (`public/`), run by
Miniflare, Cloudflare's own local runtime (the one `wrangler dev` uses), inside an Electron
window.
The database is SQLite and the files (pictures, receipts, design files) are kept on disk, both in
your user folder. Nothing is sent anywhere, unless you add a Shippo key for carrier shipping
([Shipping](#shipping)) or turn on [supplier connections](#supplier-connections).

| | Cloud install | Desktop version |
|---|---|---|
| Storefront (shops online) | optional | **off** (locked) |
| Email: confirmations, invoices, payment links, design proofs, the morning roll-up | yes | **none** |
| Card payments (Stripe) | optional | **none**: payments are recorded by hand |
| Shipping an order: address, carrier, charge, tracking number | yes | yes, typed in (Local sale → Ship this order) |
| Carrier rates, buying labels, tracking checks (Shippo) | optional | optional, with a Shippo key and the internet |
| Orders entered by hand (Local sale), production, inventory, cost of goods | yes | yes |
| Expenses, accounts, reconciling, closing months, the accountant export | yes | yes |
| Pictures, receipts, design files | R2 buckets | ordinary files in the data folder |
| Several people signing in | yes | yes, on that one computer |
| Supplier files (CSV, PDF invoices, product files) | yes | yes |
| A supplier's live connection (PromoStandards), ordering from it, its shipment notices | yes | optional, once turned on (needs the internet) |
| Sending designs to machines | the send-agent | the send-agent on the same computer; no relay from a phone |

There is **one default shop**, "My shop", made on the first start; rename it under Manage catalog →
Edit. You can add more shops (to keep a team's or a school's orders apart, say). They're only for
grouping orders and products. There are no shop pages, and nothing is published.

### How the code knows

`desktop/server.js` runs the Worker with `EDITION=desktop` ([configuration.md](configuration.md)).
With it:

- `localhost` is the admin panel and no other name is anything (`functions/_lib/hostConfig.js`),
  so a web page that points a name of its own at this computer gets nothing.
- The storefront and design approval are saved off at every start and can't be turned on, and so
  is carrier shipping while the program has no Shippo key (`functions/_lib/desktop.js`,
  `desktopLockedFeatures` in `hostConfig.js`, `updateFeatures` in `functions/api/orders.js`).
- Actions that need the internet are refused (`DESKTOP_REFUSED_ACTIONS` in `orders.js`), and the
  admin leaves out their pages and buttons. Supplier connections (`DESKTOP_SUPPLIER_ACTIONS`) are
  refused only until the owner turns them on, which sets `DESKTOP_SUPPLIERS=on`.
- Global settings → Setup status lists only the business profile, sales tax and time zone.

A cloud install never sets `EDITION`, so none of this changes it.

## Getting it

From the project's GitHub Actions: the **Desktop builds** workflow's run → Artifacts.

- **Windows**: `OpenDecoDesk-<version>-windows-portable.exe`. One file; no installer. Windows
  warns about an unknown publisher the first time. Choose *More info → Run anyway*.
- **Mac**: `OpenDecoDesk-<version>-mac-arm64.zip` (Apple silicon) or `-mac-x64.zip` (Intel).
  Unzip and move OpenDecoDesk to Applications. The first time, macOS refuses to open it because it
  isn't from an identified developer. Open *System Settings → Privacy & Security*, and choose
  *Open Anyway* next to the message about OpenDecoDesk.

The warnings go away once the builds are signed (an Apple Developer ID and a Windows code-signing
certificate, both paid). Signing can be added to the workflow later without changing the program.

## The first start

1. **Finish setting up**: your name, an email (you sign in with it) and a password of at least 12
   characters. You are then asked to sign in with them.
2. **Global settings** opens by itself. Fill in the business name, the time zone and country, and the
   sales tax rate and state (leave it at 0 if you don't collect any). Save.
3. Add products under Manage catalog (or Shop setup, which builds them from blanks), then take
   orders with **+ Local sale** on the Orders page.

## Shipping

**By hand, offline.** In **+ Local sale**, tick **Ship this order**: the address, the carrier (USPS,
UPS, FedEx or other) and service, and the shipping charge. The charge is added to what the customer
pays (shipping isn't taxed), and the address decides the sales tax as on any order. Once it's sent,
select the order and use **Add tracking**: the tracking number links to the carrier's own page
(USPS, UPS or FedEx, from the carrier on the order), which opens in your browser. Mark it shipped
and delivered from the order's stage list. Mailing labels and packing slips print as always.

**With a Shippo key (optional).** Shippo is a shipping service that buys postage from the carriers.
With a key from your Shippo account, the program can get carrier rates, buy and print labels, and
follow tracking. This needs the internet, and labels are paid to Shippo.

1. **Settings → Global settings and carrier shipping…**, then *Carrier shipping (Shippo)*: paste
   the API token from Shippo (its Settings → API) and choose **Save key**. The program restarts for
   a moment. The key is kept with the program's other secrets in `desktop.json`, encrypted where
   the system has a keychain, and never in the database.
2. Turn on **Shipping** under Features, and fill in the **Ship-from address** that appears. Region's
   country must be the US: carrier rates and labels are US-only, as on a cloud install.
3. An order with an address then has a **Ship** button: it gets the rates and buys the label.

Tracking is checked a minute after the program opens and every two hours while it stays open
(there is no server running in between). Orders the carrier has picked up are marked shipped, and
delivered ones delivered. **Check tracking now** on the Orders page does it at once. No email goes
to the customer from the desktop version.

**Remove key** puts shipping back to by hand. Labels already bought stay on their orders.

## Supplier connections

Importing a supplier's files always works: S&S or SanMar product files, CSV, and vendor PDF
invoices (Blanks → Import from PDF). Product photos that a file only links to aren't copied in
unless supplier connections are on.

**Vendor integrations** go further: a supplier's live product data and prices (PromoStandards),
ordering blanks from it from Blanks to order, and its shipment notices. They need the internet,
so they are off until you turn them on: **Settings → Global settings and carrier shipping…**, then
**Turn on supplier connections** under *Supplier connections*. The program restarts for a moment,
and Vendor integrations appear under Settings in the menu, where you add each supplier's login
as on a cloud install. The logins are saved in the database, encrypted with a key only this
program holds (`desktop.json`).

While the program is open, suppliers' shipment notices are checked a minute after it opens and
every two hours. Turning supplier connections off hides Vendor integrations again and stops
anything going to your suppliers. Saved connections and orders already placed are kept for when
it's turned back on.

## Where your data is

| | |
|---|---|
| Windows | `%APPDATA%\OpenDecoDesk` |
| Mac | `~/Library/Application Support/OpenDecoDesk` |
| Linux | `~/.config/OpenDecoDesk` |

**File → Open the data folder** opens it. Inside:

- `state/files/`: pictures (`images/`), receipts (`receipts/`) and design files (`designs/`) as
  ordinary files, under the names the program gave them. A hidden `.meta/` folder beside them keeps
  each one's type, original name and upload time. The Worker uses them as its R2 buckets
  (`desktop/files.js`, `desktop/r2-files-binding.mjs`); they don't depend on Miniflare.
- `state/d1/`: the database, a SQLite file any SQLite tool can open.
- `state/do/`: the send-agent's mailbox.
- `desktop.json`: the port, the secrets the program signs links and passwords with, and the last
  database update applied.
- `logs/opendecodesk.log`: what the program and the Worker printed, each line with its time.
  **Help → Open the log** opens it. Send it along when reporting a problem. It never holds
  passwords or keys. At 5 MB it becomes `opendecodesk.log.1` and a new one starts.
- `backups/` and `electron/` (the window's own storage).

Earlier test versions kept the files in Miniflare's own storage (`state/r2/`). The first start of
this version copies them into `state/files/` and moves the old folder to `backups/` for you to
delete once you're happy.

The secrets in `desktop.json` are encrypted with the system's keychain where there is one (Windows
and Mac). The database and files themselves are not encrypted. Your password keeps people out of
the program, but anyone who can read your user folder can read the files. Use the computer's own
account password and disk encryption (BitLocker, FileVault) for that.

The program keeps its data out of its own folder, so replacing the program with a newer download
keeps everything.

## Backups

There is no cloud copy. **File → Back up…** asks for a folder (a USB drive, a synced folder) and
copies everything into `OpenDecoDesk backup <date and time>` there: the database, pictures, receipts
and design files. The program closes the database for the few seconds this takes.

It reminds you: once your last backup is a week old, or a day after you first used the program with
no backup yet, a note under the menu says so, with **Back up now**. **Later** hides it until the
program is next opened.

**File → Restore a backup…** puts one back. What was there is moved to `backups/before-restore-…`
in the data folder, not deleted. You sign in with the password that was in use when the backup was
made.

A newer version of the program updates the database on its first start (the same migrations as a
cloud install, `desktop/migrate.js`), and copies it to `backups/before-update-…` first.

## Locked out

**Help → Locked out? Reset sign-in…** makes a new secret. Every password and two-step sign-in stops
working, and the program asks for your name, email and a new password again, as on the first start.
Other people then get a new password from you under Security → Users. Orders, books and settings
are not touched. This is the desktop version of `npm run setup -- --new-passphrase`
([operations.md](operations.md)). Anyone who can use your computer account can also do it, so it is
not a barrier against them. The computer's own sign-in is.

## Running it from the source, and building it

This needs **Node.js 22.12 or newer** (`node -v`). Electron's installer fails on older 22.x
releases with `ERR_REQUIRE_ESM`; after updating Node, delete `desktop/node_modules` and run
`npm install` again.

```bash
cd desktop
npm install        # Electron, Miniflare and electron-builder
npm start          # the program, on the repository's own files
```

`npm start -- --data-dir=<folder>` keeps the data somewhere else (a test folder, say).

Without Electron, `node desktop/server.js <data folder>` runs the same server and prints an address
to open in a browser. The first sign-in then needs the passphrase from `desktop.json` (the program
fills it in itself).

Builds, on the system they're for (Windows builds on Windows, Mac builds on a Mac; the workflow does
both):

```bash
cd desktop
npx electron-builder --win portable --x64     # dist/OpenDecoDesk-<version>-windows-portable.exe
npx electron-builder --mac zip --arm64 --x64  # dist/OpenDecoDesk-<version>-mac-arm64.zip and -mac-x64.zip
```

(`desktop/package.json` has the same two as its `dist:win` and `dist:mac` scripts.)

The program's icon is the OpenDecoDesk logo, `public/images/icon.svg`, which is also the admin's
browser-tab icon and the website's. `desktop/icons/` has it in each system's format (`icon.icns`
for the Mac, `icon.ico` for Windows, `icon.png` for the window). After changing the logo, run
`npx electron icons/make-icons.js` in `desktop/` and commit what it writes.

A build carries `src/`, `functions/`, `public/`, `migrations/`, `schema.sql`, `LICENSE` and
`NOTICE` next to the program, and runs them as they are. It has no build step of its own. On
Linux the packaged program is about 440 MB unpacked, nearly all of it Electron (about 280 MB) and
Cloudflare's `workerd` runtime (about 120 MB). The Windows and Mac downloads are compressed, but
their sizes haven't been measured yet.

## Licence

The desktop version is OpenDecoDesk, under the same AGPL-3.0 licence ([LICENSE](../LICENSE)). The
program carries the licence and NOTICE, and **Help → Source code and licence** links to the source.
