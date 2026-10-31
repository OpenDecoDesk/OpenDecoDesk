# Installing

> **Status: the installer has completed one install on a real Cloudflare account, in its smallest
> form:** an account without R2, no file storage, every optional service skipped. Creating the R2
> buckets, each optional service, and a second run that adds one have run only against a
> simulated `wrangler`. Expect to hit something on those. Run `npm run setup -- --dry-run`
> first, and if a step fails, the "by hand" section below shows what that step was trying to do.

No terminal? [install-one-click.md](install-one-click.md) installs with the Deploy to Cloudflare
button instead (early; it says what has been tested).

## Before you start

New to these services? [accounts-and-keys.md](accounts-and-keys.md) walks through creating each
account and finding every value the installer asks for. The short list:

- A **Cloudflare account**. **R2** (file storage) is optional. Without it the installer asks
  whether to carry on, and product pictures, receipts and design files can't be uploaded until
  you switch it on (Cloudflare dashboard → Storage & databases → R2; expect its one-time checkout
  to ask for a payment method) and run setup again.
- A **domain on that Cloudflare account** (its DNS is managed by Cloudflare).
- **Node.js 22 or newer** and **git** on your computer. macOS or Linux; the installer has not been
  tried on Windows (WSL should behave like Linux).
- This repository downloaded: `git clone …`, then `npm ci` in its folder.
- Signed in to Cloudflare from the command line: `npx wrangler login`.

What it costs is covered in the [README](../README.md#what-it-costs).

## The installer

```bash
npm run setup -- --dry-run    # shows every command it would run; changes nothing
npm run setup                 # the real thing
```

It works through nine steps and says what it is doing at each one.

1. **Checks `wrangler`** runs and is signed in, and whether R2 is switched on. If R2 is off it
   says so and asks whether to install without file storage, before it asks anything else or
   creates anything.
2. **Asks a few questions.** Press Enter to accept a suggestion shown in `[brackets]`.
   - *Your domain* — e.g. `myshop.com` (no `https://`, no `www.`).
   - *Subdomain for the admin panel* — default `admin`, giving `admin.myshop.com`.
   - *Business name* and *owner's email* — saved into the business profile. Both can be left
     blank and filled in from the admin later.
   - *Time zone* — an IANA name such as `Europe/London`; it suggests your computer's.
   - *Public address of the images bucket* — leave blank the first time (see "Afterwards").
3. **Database.** Finds the D1 database named in `wrangler.toml` (`opendecodesk-db`) or creates it.
4. **File storage.** Finds or creates the three R2 buckets: images, receipts, designs. The
   repository ships with the three bucket blocks in `wrangler.toml` commented out inside a marked
   block, so a site without R2 deploys. When R2 is on, this step puts them back. When it's off,
   they stay commented out, and a later run puts them back and makes the buckets once R2 is on.
5. **Writes `wrangler.toml`**: the database id, your admin hostname, and the plain settings
   (`ROOT_DOMAIN`, `ADMIN_SUBDOMAIN`, `TIMEZONE`, and `R2_PUBLIC_BASE` if you gave one). Every
   comment and every other line of the file is kept. The installer only touches the database id
   and two blocks it marks with `# >>> npm run setup` … `# <<< npm run setup`.
   **Other shops' hostnames are not added here** — see [shops-and-domains.md](shops-and-domains.md).
6. **Creates the database tables.** A new database is built from `schema.sql`, and every file in
   `migrations/` is recorded as already applied (they are all part of that schema — the migration
   files are *changes* to an existing database and can't build one from nothing). A database that
   already has its tables just gets any migrations it doesn't have yet.
7. **Secrets.** Generates the admin passphrase, the signing secret and the roll-up key, then asks
   about each optional service in turn. **Enter skips each one**; you can run setup again later to
   add any of them. Keys are typed with the screen echo off and are never printed.
   - Card payments (Stripe) — secret key; the webhook secret comes on a second run (below).
   - Shipping rates and labels (Shippo) — US only.
   - Email — Resend, or Cloudflare Email Service. See [email.md](email.md).
   - Bot check on orders (Cloudflare Turnstile).
   - Cloudflare Access in front of the admin — only if the Access application already exists.
   - Automatic hostnames for new shops.
   - The send-agent relay (embroidery machines from a phone or tablet).

   Where each of these values comes from is in [accounts-and-keys.md](accounts-and-keys.md).

   A service is only set up if you answer all of its questions. Leave one blank and that service
   is skipped whole — half a service is worse than none.
8. **Business profile.** Saves the business name and owner's email into the database.
9. **Deploys.** The secrets travel to Cloudflare in one temporary file that only your user can
   read and that is deleted as soon as the deploy returns.

At the end it prints a to-do list and, **once**, the admin passphrase it generated. It is the way
in to a new install and nothing more: the first sign-in with it asks for your name, your email
and a password of your own, and from then on you sign in with those and the printed passphrase
stops working. If you are ever locked out, `npm run setup -- --new-passphrase` prints a new one
([operations.md](operations.md#locked-out)).

### If it stops

It says which step failed, shows `wrangler`'s own error, and lists what was already done. Fix the
problem and run `npm run setup` again: every step first looks at what exists, so the database,
buckets and tables are not created twice. Secrets that were generated
but not yet deployed are simply generated again.

The most likely first-run problems (the first has happened on a real account; the rest are
expected, not confirmed):

- *R2 isn't enabled on the account* — step 1 says so and asks whether to install without file
  storage. Answer no and it stops, having changed nothing. Both the detection (`wrangler`'s
  line is "Please enable R2 through the Cloudflare Dashboard") and an install that carried on
  without storage have happened on a real account.
- *The bucket listing fails for another reason* (several Cloudflare accounts on one login, a
  token without R2 permission, no connection) — step 1 stops with "Could not list your R2
  buckets" and `wrangler`'s own lines above the hint.
- *The admin hostname already has a DNS record* — step 9 fails; delete that record in the
  dashboard (DNS) so Cloudflare can create its own, and run again.
- *`wrangler` prints its answers differently from what the installer expects* — it will say it
  could not read the answer; do that step by hand (below) and run again. `npm ci` installs the
  `wrangler` version this project is tested with (pinned in `package.json`), and `npx wrangler` uses it;
  a different global `wrangler` isn't used.

### Options

| Option | What it does |
|---|---|
| `--dry-run` | Prints every command with secrets left out; calls nothing and changes no file. |
| `--config <path>` | Use another `wrangler.toml`. |
| `--skip-deploy` | Do everything except the deploy. Secrets are not stored. |
| `--new-passphrase` | Replace the admin passphrase even though one is set. This is how a locked-out admin gets back in; it voids every user's password. |

## Afterwards

1. **Sign in** at `https://admin.<your domain>`: leave the email empty and type the passphrase.
   A new hostname can take a few minutes to get its certificate. The first screen asks for your
   name, your email and a password of your own; once you have saved it you sign in again with
   that email and password. You are the first admin. Add other people under Security → Users
   ([operations.md](operations.md#users-and-roles)), and change your password under
   Security → Change password.
2. **Turn on two-step sign-in**: Security → Security (2FA).
3. **Tools → Global settings.** The **Setup status** list at the top shows what's still missing.
   While something required or recommended is missing, signing in opens this page first.
   Fill in the Business profile, Region and Sales tax.
4. **Make the images bucket public.** In the Cloudflare dashboard, give the bucket
   `opendecodesk-images` a public address: a custom domain (for example `images.myshop.com`) or
   the public development address R2 offers. (These are Cloudflare's screens; their wording isn't
   repeated here because it changes.) Then run `npm run setup` again and give that address when asked — it
   becomes `R2_PUBLIC_BASE`. Until then pictures can't be uploaded. **Leave the receipts and
   designs buckets private.**
5. **Email**: verify your domain with the provider you chose — [email.md](email.md).
6. **Stripe**: in Stripe, add a webhook endpoint at `https://admin.<your domain>/api/stripe-webhook`
   for these events: `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
   `checkout.session.async_payment_failed`, `charge.refunded`, `charge.dispute.created`,
   `charge.dispute.closed`, `payout.paid`. If Stripe asks for a payload format, choose Snapshot.
   Stripe then shows a signing secret (`whsec_…`): run
   `npm run setup` again, answer `y` to Stripe, press Enter at the key (it's kept) and paste the
   signing secret. Until you do, card payments are charged but not recorded.
7. **Create your first shop** — [shops-and-domains.md](shops-and-domains.md).
8. **Set up backups** — [operations.md](operations.md).

## The same steps by hand

Use this if the installer fails at a step, or if you'd rather see each command.

```bash
npm ci
npx wrangler login

# 3. Database — note the id it prints
npx wrangler d1 create opendecodesk-db

# 4. Buckets
npx wrangler r2 bucket create opendecodesk-images
npx wrangler r2 bucket create opendecodesk-receipts
npx wrangler r2 bucket create opendecodesk-designs
```

**5. Edit `wrangler.toml`:**

- Put the database id in `database_id = "…"` under `[[d1_databases]]`.
- Add your admin hostname above the first `[section]` of the file:

  ```toml
  routes = [
    { pattern = "admin.myshop.com", custom_domain = true },
  ]
  ```

- Add the plain settings at the end of the file:

  ```toml
  [vars]
  ROOT_DOMAIN = "myshop.com"
  ADMIN_SUBDOMAIN = "admin"
  TIMEZONE = "Europe/London"
  ```

```bash
# 6. Tables — for a NEW database only. This is schema.sql plus a record that every migration is
#    already part of it. (Do NOT start with `npm run db:migrate` on an empty database: the first
#    migration changes a table that doesn't exist yet. db:migrate is for upgrades.)
node scripts/setup.mjs --print-fresh-sql > fresh.sql
npx wrangler d1 execute DB --remote --file fresh.sql
npx wrangler d1 migrations list DB --remote      # should say there is nothing to apply
rm fresh.sql

# 9. Deploy (first, so the Worker exists when the secrets are added)
npx wrangler deploy

# 7. Secrets — each command asks for the value
npx wrangler secret put PROXY_ADMIN_PASSPHRASE   # a long passphrase you'll type to sign in
npx wrangler secret put SIGNING_SECRET           # a long random string, e.g. from: openssl rand -hex 32
npx wrangler secret put CRON_SECRET              # optional; another long random string
```

Add the secrets and settings for any optional service from
[configuration.md](configuration.md) the same way (secrets with `wrangler secret put`, plain
settings in `[vars]` followed by `npm run deploy`).

**8.** Sign in and fill in Tools → Global settings → Business profile.

The differences from the installer: it deploys once, with the secrets, so the Worker is never live
without its passphrase (by hand there is a moment when it is — sign-in is simply refused until the
passphrase is set); and it generates the passphrase and random strings for you.
