OpenDecoDesk's back office as a program on one computer, for a shop that doesn't sell online. You
don't need a Cloudflare account, a domain or a web shop. Orders entered by hand, production,
inventory and cost of goods, and the books, with everything kept on your own computer.

**This is an early release.** Make backups (File → Back up…).

**New in this release:** the version is the date of the release and that day's build number (the
release's title has it, such as 2026.11.01.01; earlier releases were 0.1.0 and 0.1.1). The window's
title bar shows it, and so does a small line above your business's name at the top of the admin.

## Downloads

- **Windows:** `OpenDecoDesk-Windows.zip`. Unzip it to a folder of its own (say
  `Documents\OpenDecoDesk`) and run `OpenDecoDesk.exe` from there. There's no installer. The first
  time, Windows warns about an unknown publisher: choose *More info → Run anyway*.
- **Mac with Apple silicon (M1 or later):** `OpenDecoDesk-macOS-AppleSilicon.zip`.
- **Mac with an Intel processor:** `OpenDecoDesk-macOS-Intel.zip`.

On a Mac, unzip it and move OpenDecoDesk to Applications. The first time, macOS won't open it
because it isn't from an identified developer: open *System Settings → Privacy & Security* and
choose *Open Anyway*. If macOS asks whether OpenDecoDesk may use its keychain item, choose
*Always Allow*.

The downloads aren't signed yet, which is why Windows and macOS warn about them.

## What's in it

- **First start:** set up your account (name, email, password), then your business's details in
  Global settings. A shop, "My shop", is ready for the orders you enter (Orders → + Local sale).
- **Back office:** production (Run order, digitizing, machines through the send-agent on the same
  computer), blanks and stock, cost of goods, expenses, accounts, reconciling, closing months and
  the accountant export.
- **Optional, each needing the internet** (Global settings → Features: tick one and its panel asks
  for what it needs):
  - **Shipping:** carrier rates, labels and tracking with your Shippo key. Without it, shipping is
    by hand: an order's address, carrier, charge and tracking number.
  - **Email:** from your own mailbox (Gmail, iCloud, Fastmail, Zoho or any SMTP server): order
    emails, invoices with a PDF of the invoice attached, and the morning roll-up.
    - **Design approval:** proofs emailed with the pictures attached, approved by reply.
  - **Supplier connections:** a supplier's live product data and prices (PromoStandards),
    ordering blanks, and shipment notices.
- **Save invoice PDF…** on any order, to print or send yourself.
- **Your data** is in `%APPDATA%\OpenDecoDesk` (Windows) or
  `~/Library/Application Support/OpenDecoDesk` (Mac), and **File → Open the data folder** opens
  it. A newer version keeps it.
- **Help → Open the log** for reporting a problem. **Help → Locked out? Reset sign-in…** if you
  can't get in. Your data isn't touched.

## Not in the desktop version

The web shop, card payments (Stripe), payment links, and anything that sends a customer to a web
page. Import from PDF uses its layout reader only (Read with AI needs Cloudflare). Microsoft 365
and Outlook.com mailboxes aren't supported yet.

## Tested so far

The Mac Apple-silicon download on a real Mac, and the Windows download on Windows 11 for ARM in
Parallels. Not yet run: Windows on an Intel or AMD PC, and the Intel Mac download.

The full guide is in `docs/desktop.md` in the repository.
