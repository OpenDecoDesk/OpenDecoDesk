# Configuration reference

OpenDecoDesk is configured in three places:

1. **`wrangler.toml`** — the things the Worker is attached to (database, buckets, hostnames) and
   the plain, non-secret settings (`[vars]`).
2. **Secrets** — keys and passwords, stored encrypted by Cloudflare. They are never written in a
   file in this repository.
3. **Global settings** — everything about the business itself, edited in the admin under
   **Tools → Global settings** and stored in the database.

`npm run setup` fills in 1 and 2 for you (see [setup.md](setup.md)). The admin's
**Tools → Global settings → Setup status** list shows which of these are set on a running install —
only whether each is set, never its value.

Everything below was read from the code (`env.NAME` in `functions/` and `src/`); the file named in
each row is where to look.

## Bindings (`wrangler.toml`)

| Binding | Kind | Required | What it is |
|---|---|---|---|
| `DB` | D1 database | yes | Everything: orders, shops, products, payments, inventory, settings, admin sessions, rate-limit counters. |
| `IMAGES` | R2 bucket, **public** | for picture uploads | Product and shop pictures, and pictures customers attach to a design approval. Needs `R2_PUBLIC_BASE` too. |
| `RECEIPTS` | R2 bucket, **private** | for receipts | Expense receipts and vendor invoices attached to stock received. Opened only through short-lived signed links. |
| `DESIGNS` | R2 bucket, **private** | for design files | Embroidery design files and files attached to order lines. Opened only through short-lived signed links. |
| `AGENT_MAILBOX` | Durable Object | for the send-agent relay | Holds jobs for the send-agent while a phone or tablet waits for the answer (`functions/_lib/agentMailbox.js`). |
| `ASSETS` | static assets | yes | Serves `public/` (the storefront and admin pages). |
| `EMAIL` | `send_email` binding | no | An alternative way to reach Cloudflare Email Service. Not declared in the shipped `wrangler.toml`; the installer uses the API-token route instead. |

Also in `wrangler.toml`: the **hostnames** the Worker serves (`routes`), and the **cron trigger**
(hourly — see [operations.md](operations.md)).

## Plain settings (`[vars]` in `wrangler.toml`)

| Name | Required | Default | What it does |
|---|---|---|---|
| `ROOT_DOMAIN` | **yes** | `example.com` (a placeholder nobody can use) | Your domain, without `www.`. The admin is `<admin>.<root>`, each shop `<shop>.<root>`. Also used for links in emails and the default sender address. (`functions/_lib/hostConfig.js`) |
| `ADMIN_SUBDOMAIN` | no | `admin` | The admin panel's subdomain. Several may be given, comma-separated; the first is used in emailed links. |
| `TIMEZONE` | no | `UTC` | The install's time zone (an IANA name such as `Europe/London`). **Global settings → Region overrides it** when a zone is saved there. |
| `DIGEST_HOUR` | no | `6` | The local hour (0–23) the morning roll-up goes out. |
| `R2_PUBLIC_BASE` | for picture uploads | — | The public address of the `IMAGES` bucket (`https://…`). Without it, uploads are refused. |
| `EMAIL_FROM` | no | `orders@<root domain>` | The address emails are sent from. Must be on a domain verified with your email provider. |
| `EMAIL_BCC` | no | — | An inbox that gets a hidden copy of every email. Overrides the "Receipts inbox" in the business profile. |
| `OWNER_EMAIL` | no | `owner@<root domain>` | Where notices to the owner go, **if** no inbox is saved in the business profile. |
| `EMAIL_SUBJECT_TAG` | no | — | Text put in front of every email subject (for telling a test install's emails from the real one's). |
| `CF_ACCOUNT_ID` | with Cloudflare email or automatic hostnames | — | Your Cloudflare account id. |
| `CF_ZONE_ID` | with automatic hostnames | — | The zone id of your domain. |
| `CF_WORKER_NAME` | with automatic hostnames | — | This Worker's name (the `name` in `wrangler.toml`). |
| `TURNSTILE_SITE_KEY` | with Turnstile | — | The public half of a Turnstile widget; sent to the storefront. |
| `ADMIN_AUTH_GLOBAL_LIMIT` | no | `100` | Failed sign-ins allowed across the whole site, from any address, per 15 minutes; past it, new sign-ins wait for the window to end (people already signed in aren't affected). `0` turns it off. Each address also has its own limit of 10 a minute. |
| `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD` | with Cloudflare Access | — | Turn on Cloudflare Access checking for the admin. See the warning below. |
| `EDITION` | no | — | Set to `desktop` **only by the desktop program** ([desktop.md](desktop.md)), never on a cloud install: `localhost` becomes the admin, the storefront, carrier shipping and design approval are locked off, and actions that need the internet are refused. There, `SHIPPO_API_KEY` is set by the program when the owner saves a Shippo key, and unlocks carrier shipping, `DESKTOP_SUPPLIERS` is `on` when the owner has turned on supplier connections (Vendor integrations), and `DESKTOP_EMAIL` is `on` when the owner has set up their mailbox (Global settings → Email): email then goes out through the `MAILER` binding, which the program answers by sending over SMTP (`desktop/mailer.js`), from `EMAIL_FROM`, the mailbox's address. (`functions/_lib/hostConfig.js`) |

Older names the code still reads, for installs that already use them — don't set these on a new
install: `CF_PAGES_PROJECT` (custom domains for a Cloudflare Pages deployment),
`SHIP_FROM_NAME` / `_STREET1` / `_CITY` / `_STATE` / `_ZIP` / `_PHONE` / `_EMAIL` (the ship-from
address, now a Global setting; a saved value wins).

## Secrets

Set by `npm run setup`, or one at a time with `npx wrangler secret put NAME`.

| Name | Required | What it does |
|---|---|---|
| `PROXY_ADMIN_PASSPHRASE` | **yes** | The way in to a new install, and the key every user's password is stored under. Without it nobody can sign in. The installer generates one and shows it once; the first sign-in with it creates the first admin, and from then on it opens nothing. Replacing it (`npm run setup -- --new-passphrase`) gets a locked-out admin back in, and voids **every** user's password. |
| `SIGNING_SECRET` | **yes** | Signs carrier shipping quotes (so a customer can't change the price) the short-lived links that open receipts and design files, and a shop's draft preview link. Any long random string. |
| `CRON_SECRET` | no | Only for starting the morning roll-up by hand (`POST /api/daily-digest` with `{"key": …}`). The scheduled roll-up doesn't use it. |
| `STRIPE_SECRET_KEY` | for card payments | Your Stripe secret key. Without it "Card" isn't offered at checkout. |
| `STRIPE_WEBHOOK_SECRET` | with Stripe | The signing secret of the Stripe webhook endpoint. **Without it, card payments are taken but never recorded on their orders** — the webhook is refused. |
| `SHIPPO_API_KEY` | for carrier shipping | Your Shippo API token: rate quotes, labels, tracking checks. |
| `RESEND_API_KEY` | one email provider | Send email through Resend. When set, Resend is used for everything. |
| `CF_EMAIL_API_TOKEN` | one email provider | A Cloudflare API token with only the Email Sending permission (used with `CF_ACCOUNT_ID`). |
| `TURNSTILE_SECRET_KEY` | with Turnstile | The secret half of the Turnstile widget. **Set it together with `TURNSTILE_SITE_KEY`** — the secret alone refuses every order. |
| `CF_API_TOKEN` | with automatic hostnames | A Cloudflare API token that can attach hostnames to this Worker. It can change your account, so give it the narrowest permissions that work (see [shops-and-domains.md](shops-and-domains.md)). |
| `VENDOR_CREDENTIALS_KEY` | with vendor connections | Encrypts the logins saved under Tools → Vendor integrations (PromoStandards). Any long random string, set once: changing it makes the saved logins unreadable (enter them again). Without it vendors can't be connected; everything else works. |
| `AGENT_TOKEN` | with the send-agent relay | Shared with the send-agent program; at least 32 characters, or the relay stays off. |

Older names still read as fallbacks: `QUOTE_SIGNING_SECRET` and `LINK_SIGNING_SECRET` (used when
`SIGNING_SECRET` isn't set; if none is set, `STRIPE_SECRET_KEY` is used as the signing key), and
`TOTP_SECRET` (a two-step sign-in secret set by hand on the oldest installs; it is read once,
when that install's owner becomes its first user, and each user's own secret is used after that).

### Two settings that lock things when half-set

- **Cloudflare Access** (`ACCESS_TEAM_DOMAIN` + `ACCESS_AUD`): once both are set, every admin
  request must carry a valid Access sign-in or it is refused. Create the Access application for your
  admin hostname *first*, then set them. If you take card payments, Stripe's webhook address on
  that hostname needs its own exemption, and the send-agent relay can't sign in through Access
  either — see [accounts-and-keys.md](accounts-and-keys.md).
- **Turnstile**: `TURNSTILE_SECRET_KEY` turns the check on. Without `TURNSTILE_SITE_KEY` the
  storefront can't show the widget, so no order can pass.

## Global settings (in the admin, stored in the database)

**Tools → Global settings.** All of these take effect without a deploy.

| Section | What it holds | Default | Notes |
|---|---|---|---|
| **Setup status** | Read-only: which of the things on this page are set. | — | |
| **Business profile** | Business name, one-line description, footer line, contact email shown to customers, your own inbox, a receipts inbox, Venmo username, Zelle contact, "checks payable to", "mail checks to", the purchase order prefix for orders placed with suppliers. | all blank ("Our shop" stands in for a missing name) | Live as soon as saved. |
| **Region** | Time zone; country (`US` or `OTHER`). | time zone from `TIMEZONE`, else UTC; country `US` | Country `OTHER` makes addresses free text and turns carrier shipping off. |
| **Features** | Five switches: Storefront, Production, Bookkeeping, Shipping, Design approval. A ticked one opens a panel with its settings (Production: Machine Files; Shipping: the Shippo key and the ship-from address). | all on | See the README. Live within about half a minute. |
| **Payment methods** | Which of Card, Venmo, Zelle, Check are offered, site-wide. Each shop can turn more off, never back on. | all on (Card also needs Stripe) | **The one section that needs Publish** (Manage catalog → Publish) to reach the storefront. |
| **Sales tax** | Rate, home state (or region), and whether prices include the tax or it is added at checkout. | no rate: nothing is taxed | Applies to new orders. See [sales-tax.md](sales-tax.md). |
| **Ship-from address** | The sender's name, address, phone and email for shipping quotes and labels. | blank | In the Shipping feature's panel. Every field is required while Shipping is on: nothing saves until it's complete. |
| **Machine Files** | Whether delete buttons are shown on the Machine Files page. | off | In the Production feature's panel. |

Settings kept elsewhere in the admin: **package sizes** (Tools → Package sizes), the **accounts
that postage is paid from and Stripe pays out to** (Finance → Accounts & money), and each shop's
own settings (Manage catalog → Edit) — delivery options, payment methods, order deadline,
tax exemption.

The database also keeps a few values the site maintains itself in the same table
(`global_settings`): the catalog version, the roll-up's progress and last run, counted failed
sign-ins, problems waiting for the next roll-up, and the two-step sign-in secret. They aren't
edited by hand.
