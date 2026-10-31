# Install with one click

The **Deploy to Cloudflare** button installs OpenDecoDesk without a terminal, Node.js or git. You need
a Cloudflare account and a free GitHub account; the button puts a copy of the code in your GitHub
account and runs it on your Cloudflare account.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/OpenDecoDesk/opendecodesk)

> **Status: early.** Here is what has been done on real Cloudflare accounts, and what hasn't.
>
> **Tested:** the button on a brand-new, free Cloudflare account with no domain and nothing else
> switched on. The copy in GitHub, the database, the build and the deploy all worked, and nothing
> asked for a card. The first sign-in on the `workers.dev` address with the setup password chosen
> on Cloudflare's page worked, as did making your own account and opening the back office's pages.
> A rebuild (a change committed to the copy) kept the account and everything made. Shops can be
> built and previewed there before the site has a domain.
>
> **Not yet tested on a real account:** connecting your domain (step 5 below). It has been run only
> against a stand-in for Cloudflare's API, and not yet on a paid plan. Workers AI (used by Blanks →
> Import from PDF) was added to the code after the button test. Expect rough edges and tell us what
> you hit.
>
> **Not built yet:** setting up card payments, shipping labels, email, the bot check and file
> storage from the app (see [After the domain](#after-the-domain)), and updating a one-click install
> to a newer version (see [Updates](#updates)).

The command-line installer ([setup.md](setup.md)) is still the way to get every service set up in
one go, and the path for anyone comfortable with a terminal.

## What it creates

- A copy of this code in your GitHub account.
- In your Cloudflare account: a Worker (the app), a D1 database (`opendecodesk-db`) and a Durable
  Object. File storage (R2) is left out, because switching it on asks for a payment method; product
  pictures, receipts and design files can't be uploaded until it is added.

Nothing is sent to the OpenDecoDesk project: the app runs entirely in your account.

## 1. Press the button

Use the button above. Sign in to Cloudflare and GitHub when asked. Don't use Cloudflare's own
**Create an application → Import a repository** instead: that route deploys with a bare
`wrangler deploy` and skips the step that builds the database.

## 2. Fill in Cloudflare's page

Change these three and leave the rest as they are:

- **Create private Git repository**: tick it, so the copy in your GitHub account isn't public.
- **PROXY_ADMIN_PASSPHRASE** (your setup password): the box shows dots, but it holds example text.
  Click into it, delete everything, and type a password of **12 characters or more** that you make
  up. It isn't your Cloudflare or GitHub password. Write it down for step 4. The site refuses the
  example text and anything shorter.
- **Enable Preview builds**: switch it off. This app doesn't use them.

Then click **Deploy**. Cloudflare builds and deploys the app, which takes a few minutes. When it
finishes it shows an address ending in **`workers.dev`**: that is your back office for now.

## 3. If the build fails

In the Cloudflare dashboard open **Workers & Pages**, then the Worker (`opendecodesk` or similar),
then **Deployments** or **Builds**, and the latest build's log. The build prints a short "What this
build sees" section first; nothing in it is secret.

## 4. Sign in for the first time

Open the `workers.dev` address.

1. Leave **email empty**, type the **setup password** from step 2, and sign in.
2. It asks for your name, email and a new password. These become your own sign-in, and the setup
   password stops working.
3. Sign in again with your email and password. Global settings opens, listing what is still to set up.

**Forgot your password later?** Another admin can give you a new one under Security → Users. If you
are the only admin, give the site a new setup password: in Cloudflare open the Worker, then
**Settings → Variables and Secrets**, and change `PROXY_ADMIN_PASSPHRASE` (12 characters or more).
Then sign in with the email empty and that setup password, and set your email and password again.
This signs everyone out and every user needs a new password; shops, orders and settings are kept.

Until the site has a domain you can build shops with **New shop setup** and look at them with
**Preview**, but none can take orders: each shop's address is part of your domain
(`<shop>.<your domain>`).

## 5. Connect your domain

Not yet tested on a real account (see the status above).

You need a domain that is on the same Cloudflare account and shows as **Active** there. To add one:
in Cloudflare, **Domains → Add a domain**. Cloudflare walks you through it; the last step is changing
the domain's nameservers at the company where you bought it, which can take up to a day. The app
uses `admin.<your domain>` and one address per shop; the domain itself and `www` are left alone.

Then, in the back office, open **Settings → Global settings**. The **Your domain** box is at the top:

1. **Make the key on Cloudflare** opens Cloudflare's API token page with the permissions filled in:
   Workers Scripts and Workers Routes (edit), Zone (read), DNS (edit) and R2 (edit, for file storage
   later). Scroll down, click **Continue to summary**, then **Create Token**, and copy the key.
2. Paste it into the box and click **Connect**. If there is more than one domain on the account it
   asks which one.
3. The app attaches `admin.<your domain>` to the Worker and keeps the key as a secret on the Worker
   (it is never shown again and isn't stored in the database). Shops you built already get their
   addresses too.
4. Open `https://admin.<your domain>` (its certificate can take a few minutes) and sign in with the
   same email and password. Once you have, the `workers.dev` address is switched off.

What the key can do: change this Cloudflare account's Workers, their web addresses and the
domain's DNS records. The app uses it to attach each new shop's address. Deleting it (Cloudflare →
My Profile → API Tokens) stops that; nothing else breaks.

What the step refuses, with a message saying what to do: a domain still waiting for its nameservers,
a domain on a different account from the site, and an `admin.` address that already has a DNS record
(it is never overwritten).

## After the domain

Card payments, shipping labels, email, the bot check on orders and file storage aren't set up from
the app yet. Until they are, add each one's keys yourself as secrets on the Worker: in Cloudflare open
the Worker, then **Settings → Variables and Secrets → Add**, type **Secret**. The names are in
[configuration.md](configuration.md), and [accounts-and-keys.md](accounts-and-keys.md) says where to
find each key. Global settings → Setup status shows which ones the site sees.

For Stripe, also create the webhook in Stripe yourself, pointing at
`https://admin.<your domain>/api/stripe-webhook`, and save its signing secret as
`STRIPE_WEBHOOK_SECRET` (the events are listed in [accounts-and-keys.md](accounts-and-keys.md)).

## Updates

The button's copy has no link back to this repository, so a newer version doesn't reach it by
itself, and updating a one-click install isn't built yet. Cloudflare rebuilds the site whenever the
copy in your GitHub account changes, and every build applies new database changes before it deploys,
keeping your data (a rebuild has been tested; an update to a newer version hasn't).

## Removing it

In Cloudflare: **Workers & Pages** → delete the Worker; **D1** → delete `opendecodesk-db`; if you
connected a domain, delete the **OpenDecoDesk** key under My Profile → API Tokens and check the
domain's DNS page for `admin.` or shop records left over. In GitHub: open your copy, then
**Settings → Delete this repository**.
