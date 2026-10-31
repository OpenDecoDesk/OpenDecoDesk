# Accounts and keys

`npm run setup` asks for keys from several outside services. This guide says which accounts you
need, how to create each one, and where to find every value the installer asks for.

> **About the menu names.** The steps below use each service's own menu and button names as its
> documentation described them in October 2026. These services rename things often. If a screen
> doesn't match, follow the service's current documentation; the *values* you are looking for stay
> the same. Nothing here quotes prices or plan limits: each service publishes its own.
>
> These steps have **not yet been followed end to end on a fresh account**: the one real install
> so far was the smallest one, with no file storage and no optional service. Unless a step says
> it was seen, it comes from the service's documentation and from
> this project's code, not from doing it. The places most likely to be wrong are marked.

## The short version

| Account | What it is for | Do you need it? | What the installer asks for |
|---|---|---|---|
| **Cloudflare** | Runs everything: the site, the database, file storage (optional), your hostnames | **Yes** | Your domain. You must also be signed in from the command line. |
| **Stripe** | Card payments | Only for cards | A secret key, then (on a second run) a webhook signing secret |
| **Shippo** | Carrier rates and labels, US only | Only for carrier shipping | An API token |
| **Resend** | Sending email | Only for email, and only if you don't use Cloudflare's email | An API key |
| **GitHub** | Nightly database backups | No. Not needed to install at all | Nothing |

Everything except Cloudflare is optional, and the installer lets you skip each one by pressing
Enter. You can run `npm run setup` again later to add a service. **For a first install, set up
Cloudflare only**, look around the admin, then add the others one at a time.

Inside your Cloudflare account there are four more optional pieces. None needs a new account:
a bot check on orders (Turnstile), a sign-in page in front of the admin (Access), automatic
hostnames for new shops, and Cloudflare's own email service. They are covered
[further down](#optional-cloudflare-extras).

**Test first.** Stripe and Shippo both give you test keys that move no money. Use those until
everything works, then switch to live keys ([Going live](#going-live)).

**Keep a private note** of what you create: the name of each key, what it is for and where it is
stored. Several of these values are shown only once.

---

## Cloudflare (required)

Before the installer can run you need three things: an account, a domain that is **Active** on
it, and the command-line tool signed in. R2, Cloudflare's file storage, is a fourth that you
can leave for later.

### 1. Create the account

1. Go to https://dash.cloudflare.com/sign-up, enter your email and a password, and create the
   account.
2. Open the email Cloudflare sends you and confirm your address.
3. Turn on two-step sign-in for the account. It will hold your shop, your customers' details and
   your DNS.

Cloudflare has two separate kinds of plan. The plan for a **domain** is chosen when you add the
domain. The **Workers** plan belongs to the account and is what this software runs on. A new
account starts on the free Workers plan. Cloudflare's documentation says each piece this project
uses (static files, scheduled runs, the D1 database and the kind of Durable Object it declares) is
available on that plan, but nobody has confirmed that a whole install stays within its limits —
see "What it costs" in the [README](../README.md#what-it-costs).

### 2. Put your domain on Cloudflare

The site only answers on real hostnames (`admin.<your domain>`, `<shop>.<your domain>`), so a
domain whose DNS is managed by Cloudflare is required.

1. In the dashboard go to **Domains** and choose **Onboard a domain**. Enter the bare domain
   (`myshop.com`, not `www.myshop.com`), let Cloudflare scan for existing DNS records, and choose
   a plan for the domain.
2. **Check the records it found.** If the domain already has a website or email, make sure those
   records are all listed. Anything missing stops working after the switch.
3. Look for an existing record named `admin` (or whatever you want the admin's subdomain to be)
   and one named `images`. The installer is refused on a hostname that already has a DNS record:
   delete an unused one, or plan to give the installer a different admin subdomain.
4. If you bought the domain from Cloudflare, you are done. Otherwise note the two nameservers
   Cloudflare shows you, sign in at the company where the domain is registered, and replace its
   nameservers with those two. If DNSSEC is on there, switch it off first.
5. Wait until the domain shows **Active** on the Domains page. Cloudflare says to allow up to 24
   hours and emails you when it is done. Don't run the installer before then.

### 3. Switch on R2 (file storage) — optional

R2 holds uploaded files: product and shop pictures, receipts attached to expenses, and design
files. Orders, payments, shipping and the rest of the back office don't use it. **Without R2
the installer asks whether to install without file storage and carries on**; those uploads are
refused until you switch R2 on and run the installer again, which then makes the buckets.
One real install has been done this way.

To switch it on, go to **Storage & databases → R2 → Overview** in the dashboard and complete the
short checkout that adds R2 to the account. You don't create any buckets yourself; the
installer does.

Expect the checkout to ask for a **payment method**. What follows is that screen as one account
on the free Workers plan showed it; the checkout was not completed there. It listed a free
monthly allowance for storage and for operations, showed nothing due on the day, and said
charges apply only for use beyond that allowance. The figures are on that screen and change, so
read them there.

### 4. Sign in from the command line

On your computer, in the project folder:

```bash
npm ci
npx wrangler --version
npx wrangler login
npx wrangler whoami
```

- `npx wrangler --version` downloads Cloudflare's command-line tool the first time (answer `y`).
  It is not installed by `npm ci`.
- `npx wrangler login` opens your browser. Sign in to Cloudflare and approve the request. Do this
  on the computer you are sitting at; it does not work over a remote session.
- `npx wrangler whoami` must show the email of the account that has your domain. **This is the
  real check.** `npm run setup -- --dry-run` does not contact Cloudflare, so a clean dry run does
  not prove you are signed in.

The sign-in is saved in a plain file on your computer. On a shared computer, run
`npx wrangler logout` when you have finished.

**If your login can reach more than one Cloudflare account**, tell the installer which one to
use. Without this the installer stops at step 1 under "Could not list your R2 buckets", with
`wrangler`'s own line about more than one account above the hint (tried only against a
simulated `wrangler`):

```bash
CLOUDFLARE_ACCOUNT_ID=<your account id> npm run setup
```

### 5. Your Account ID and Zone ID

You only need these for some optional services (Cloudflare email, automatic hostnames, backups).
They are identifiers, not secrets, and can be copied again at any time.

- **Account ID**: on the dashboard's home page open Search, type `Copy account ID` and choose
  that result. It is also shown under **Workers & Pages**.
- **Zone ID**: go to **Domains**, choose your domain, and scroll the Overview page down to the
  **API** section. Both ids are shown there. They look alike — don't mix them up.

### 6. Afterwards: a public address for the pictures bucket

Pictures can't be uploaded until the images bucket has a public address. Do this after the
first successful `npm run setup`:

1. In the dashboard go to **Storage & databases → R2**, open the bucket `opendecodesk-images`,
   then **Settings**.
2. Under **Custom Domains** choose **Add**, enter `images.<your domain>`, and connect it. Wait
   for the status to become Active.
3. Run `npm run setup` again and give `https://images.<your domain>` when it asks for the public
   address of the images bucket.

Attach that name to the **bucket**, not to the Worker. Leave `opendecodesk-receipts` and
`opendecodesk-designs` private: they hold your receipts and design files. Choose the address
before you upload a catalog — each picture's link is built from the address set at the time.

---

## Stripe (card payments)

Without Stripe, "Card" isn't offered at checkout; Venmo, Zelle and check still work. Stripe needs
**two** values, fetched in **two passes**, and the second one is easy to forget:

> With the secret key set but no webhook signing secret, cards **are charged but the payments are
> never recorded on their orders.** Don't take real card orders until both are in and a test
> payment has shown up on an order.

### Create the account

1. Create an account at https://dashboard.stripe.com/register. Use an email you will keep.
2. A new account starts in a **sandbox** (Stripe's test environment, formerly "test mode"). No
   real money moves and nothing about your business has to be verified. A banner at the top of
   the dashboard says when you are in a sandbox.
3. Turn on two-step sign-in for your Stripe login.

You can stop here and test. Before live payments, Stripe needs your business details and a bank
account ([Going live](#going-live)).

### First pass: the secret key (`STRIPE_SECRET_KEY`)

1. In the sandbox, open the API keys page: https://dashboard.stripe.com/apikeys (also reachable
   from **Developers → Workbench**).
2. Under **Standard keys**, copy the **Secret key**. It starts with `sk_test_`.
   Not the publishable key (`pk_…`), which is on the same page and is the wrong one.
3. Run `npm run setup`. Answer `y` to "Card payments (Stripe)" — Enter skips it.
4. Paste the key. Nothing appears on screen as you paste; that is intended.
5. At the webhook signing secret question, **press Enter**. You can't have that value yet.
6. Let the installer deploy. Its closing list prints the webhook address for the next pass.

### Second pass: the webhook signing secret (`STRIPE_WEBHOOK_SECRET`)

Do this once `https://admin.<your domain>` opens in a browser.

1. In Stripe, **in the same sandbox the key came from**, open the Webhooks page:
   https://dashboard.stripe.com/webhooks (also **Developers → Workbench → Webhooks**).
2. Add a destination (Stripe now calls a webhook endpoint an "event destination").
3. Events from **your account**. For the payload format choose **Snapshot**, not Thin. Stripe
   marks Thin as recommended, but this software reads the full object inside each event, which
   only Snapshot events carry.
4. Select exactly these seven events:
   `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
   `checkout.session.async_payment_failed`, `charge.refunded`, `charge.dispute.created`,
   `charge.dispute.closed`, `payout.paid`.
5. Destination type **Webhook endpoint**, with the address
   `https://admin.<your domain>/api/stripe-webhook`.
6. Create it, then reveal its **signing secret**. It starts with `whsec_`.
7. Run `npm run setup` again. Answer `y` to Stripe, press **Enter** at the key (it is kept), and
   paste the signing secret.

### Check it works

1. In the admin, **Tools → Global settings**: the Setup status line for card payments should be
   complete. Make sure Card is on under Payment methods, then **Manage catalog → Publish**.
2. On the Orders screen pick a shop and use **Create test transaction**.
3. On Stripe's page pay with the test card `4242 4242 4242 4242`, any future expiry date and any
   three-digit code.
4. In Stripe, the destination's delivery list should show `checkout.session.completed` delivered
   with status 200. In the admin, the `TEST-` order should show a card payment and read paid.

If Stripe shows **401 "Invalid signature"**, the stored signing secret doesn't belong to that
endpoint (wrong endpoint, or a sandbox secret with live events). **500 "Webhook not configured"**
means the second pass was never done.

### A restricted key

The installer expects a standard secret key. Stripe's restricted keys should also work, but this
project has **not been tested with one**. From the calls the code makes, such a key would need:
Checkout Sessions *write*; PaymentIntents, Charges, balance transactions and Refunds *read*; and
nothing else.

---

## Shippo (carrier shipping, US only)

Without Shippo, shops can still offer local pickup and their own flat-fee delivery options.
Carrier shipping also needs the Region set to US and the Shipping feature on.

### Create the account

1. Create an account at https://apps.goshippo.com/join.
2. Start with a **test token**: it needs no payment method and nothing is charged.
3. Before buying real labels, add a payment method in Shippo's billing settings. Labels bought
   through Shippo's own carrier accounts are charged to it.
4. Shippo's own carrier accounts for US shipments are available by default, so you can buy
   labels without opening an account with a carrier. Turn off any carrier you won't actually
   use: the site asks for rates from every active carrier and shows the customer the cheapest.

You don't need to enter a sender address or package sizes in Shippo. This software sends both
with every request, from its own settings.

### The API token (`SHIPPO_API_KEY`)

1. Sign in to Shippo's API portal: https://portal.goshippo.com/api-config/api
2. Open **Developer keys → Test keys** and create a test key. It starts with `shippo_test_`.
3. Copy it at once. Shippo shows the full key only one time.
4. Run `npm run setup`, answer `y` to "Shipping rates and labels (Shippo, US only)" and paste it.

A mistyped token is accepted by the installer and still shows as "set" in the admin. The failure
shows up later, as "Could not get shipping rates" at checkout. If quotes fail for every ZIP,
suspect the token.

**What a test token does:** rates come back (Shippo says they may differ from live rates), and
labels are created but marked as samples that can't be mailed. Their tracking never updates.

### On the OpenDecoDesk side

In the admin, under **Tools → Global settings**: set the Region's country to US, leave the
Shipping feature on, and fill in the **Ship-from address** (rate quotes work with just the ZIP; a
label can't be bought without street, city, state, ZIP and phone). Then check **Tools → Package
sizes**, give every product a weight, and add the Shipping option to each shop that ships
(**Manage catalog → the shop → Edit → Delivery & pickup**). Add that option only after the token
is in, or customers see an error where the rates should be.

### Check it works

Open a shop, put something in the cart and type a ZIP at checkout: up to three rates should
appear. Then, on a paid order with a shipping address, use **Ship** on the Orders screen and buy
a (sample) label.

---

## Email

The site sends through **one** provider. With none set up, no email is sent at all; orders still
work. Whichever you choose, **nothing is delivered until your sending domain is verified with
that provider**, and the installer can't check that for you. See [email.md](email.md) for what
gets sent and to whom.

### Resend

**First decide your sender address.** The default is `orders@<your domain>`. The rule: the part
after the `@` must be a domain Resend shows as **Verified**.

1. Create an account at Resend and open the Domains page: https://resend.com/domains
2. Choose **Add Domain** and enter your domain. (Resend recommends a subdomain such as
   `mail.myshop.com`. If you do that, the sender address must be on that subdomain too, for
   example `orders@mail.myshop.com`.)
3. Resend lists the DNS records it wants. Either let Resend add them through its "Sign in to
   Cloudflare" option, or add each one by hand in the Cloudflare dashboard under your domain's
   DNS records. Copy exactly what Resend shows. If a record has a proxy switch in Cloudflare,
   set it to **DNS only**.
4. If the domain already has SPF, DKIM or DMARC records from another mail service, don't delete
   them; read Resend's notes on combining them.
5. In Resend choose **Verify DNS Records** and wait for **Verified**. Resend says this is often
   quick but can take up to 72 hours.

Then the key (`RESEND_API_KEY`):

1. Open the API keys page: https://resend.com/api-keys and choose **Create API Key**.
2. Permission: **Sending access**, limited to your one domain. The site only ever sends; it
   never reads or changes anything in your Resend account.
3. Copy the key at once (it starts with `re_`). Resend shows it only one time.
4. Run `npm run setup`, answer `r` at Email and paste it. At the sender address question press
   Enter for `orders@<your domain>`, or type your subdomain address.

The admin will say email is ready as soon as a key exists; it can't tell whether the domain is
verified. Test with a real order to your own address. If nothing arrives, look at
**Tools → Communications** in the admin, then at Resend's own list of sent emails.

### Cloudflare Email Service (instead of Resend)

Cloudflare's documentation says sending to your customers needs the paid Workers plan.

1. In the Cloudflare dashboard go to **Compute → Email Service → Email Sending**, choose
   **Onboard Domain**, pick your domain and accept the DNS records it adds.
2. Create an API token ([how](#creating-a-cloudflare-api-token)) with one permission only:
   **Email Sending → Edit**, on your one account. This is `CF_EMAIL_API_TOKEN`.
3. Run `npm run setup`, answer `c` at Email, and paste the token and your Account ID.

Don't reuse the hostnames token here. And note that if a Resend key is also set, Resend is used
for everything.

---

## Optional Cloudflare extras

### Creating a Cloudflare API token

Three optional features each need their own token. The steps are the same; only the
permissions differ.

1. Open https://dash.cloudflare.com/profile/api-tokens (**My Profile → API Tokens**) and choose
   **Create Token**, then the custom token option.
2. Give it a name that says what it is for.
3. Add only the permissions listed for that feature.
4. Limit it to your **one account**, and where it has zone permissions, to your **one domain**.
5. Create it and copy it at once. Cloudflare shows it only one time.

| Token | Used for | Permissions | Where it goes |
|---|---|---|---|
| `CF_API_TOKEN` | Automatic hostnames for new shops | Account → Workers Scripts: Edit; Zone → Workers Routes: Edit; Zone → DNS: Read | The installer |
| `CF_EMAIL_API_TOKEN` | Cloudflare Email Service | Email Sending: Edit | The installer |
| `CLOUDFLARE_API_TOKEN` | Nightly backups | Account → D1: Read; Account → Workers R2 Storage: Edit | A GitHub secret |

**Make three separate tokens.** Then revoking one breaks only one thing. The hostnames token is
the most powerful value the site holds: it can change Workers on your account. If the backup's
first run is refused at the export step, change that token's D1 permission from Read to Edit
(whether Read is enough has not been tested).

### Automatic hostnames for new shops

Without this, each new shop's address is attached by hand
([shops-and-domains.md](shops-and-domains.md)). With it, creating a shop in the admin attaches
`<shop>.<your domain>` for you. The installer asks for `CF_API_TOKEN`, your Account ID and your
Zone ID; all three must be given or the feature stays off.

### Bot check on orders (Turnstile)

1. In the Cloudflare dashboard open **Turnstile** and choose **Add widget**.
2. Under hostnames add your bare domain (`myshop.com`). That covers every shop under it,
   including ones you add later.
3. Widget mode **Managed**. Create it and copy the **site key** and the **secret key**.
4. Run `npm run setup`, answer `y` to "Bot check on orders" and give both.

**Enter both in the same run.** The secret key alone switches the check on while the storefront
can't show it, and every order is refused. Most customers never see the widget: it only appears
when Cloudflare wants an interaction.

### Optional: Cloudflare Access

Cloudflare Access puts Cloudflare's own sign-in in front of the back office. It is **an extra
gate, not a replacement**: with it on, people sign in twice — to Access first, then to the app
with their own email and password. The app's users, roles and two-step sign-in work the same
with or without it. Most shops don't need it; it suits one that already uses Cloudflare Zero
Trust and wants the admin unreachable to anyone outside its list.

**What to protect.** The back office lives on its own hostname, `admin.<your domain>`, so scope
the Access application to that hostname. These are the paths a signed-in user's browser uses
there, if you prefer to list them:

| Path | What it is |
|---|---|
| `/`, `/admin.js`, `/admin-qr.js`, `/vendor/pdfjs/` | The admin page and its scripts |
| `/api/admin-session`, `/api/admin-password`, `/api/admin-2fa`, `/api/admin-users` | Signing in, your account, users |
| `/api/orders`, `/api/shippo-label`, `/api/upload`, `/api/design`, `/api/receipt`, `/api/agent` | The back office's own work |
| `/api/catalog`, `/api/shipping`, `/api/image-proxy` | Shared with the storefront, also called from the admin |

**What must stay reachable without Access:**

- **Every shop hostname** (`<shop>.<your domain>`) and your bare domain: the storefront,
  checkout, and the links customers get by email. Don't put Access on those.
- **`/api/stripe-webhook` on the admin hostname**, if you take cards: that is the address the
  installer tells you to register with Stripe, and Stripe can't sign in. It needs a bypass
  (step 3 below).
- **`/api/daily-digest`**, only if you start the roll-up by hand: call it on a shop hostname.

**The workers.dev address.** A Worker can also be reached at a `*.workers.dev` address and at
preview addresses, which Access on your own hostname does not cover. This project ships with
both switched off in `wrangler.toml` (`workers_dev = false`, `preview_urls = false`). Leave them
off, or Access can be walked around.

> **Order matters.** Create and test the Access application first. Once the two values are set,
> every admin request without a valid Access sign-in is refused.

1. In the dashboard choose **Zero Trust** and pick a team name. Your team domain is
   `<team name>.cloudflareaccess.com`.
2. Under **Access controls → Applications** create a **self-hosted** application for
   `admin.<your domain>`, with a policy that **allows** only the email addresses of the people
   who use the back office. This is the main application; step 5 needs its tag.
3. **If you take card payments, add a second application for the same hostname with the path
   `api/stripe-webhook`, and give it a Bypass policy for everyone.** Without this, Stripe's calls
   are stopped before they reach the site and card payments are charged but not recorded. The
   address is safe to leave open because the site checks Stripe's signature on every call. (This
   step is worked out from how the site and Access behave; it has not been tested on a live
   install.)
4. Open `https://admin.<your domain>` in a private window and check Cloudflare's sign-in appears
   and lets you in.
5. In the settings of the **main** application (the one for the whole hostname, not the bypass
   one) copy the **Application Audience (AUD) tag**. Each application has its own tag, and the
   wrong one locks you out of the admin.
6. Run `npm run setup`, answer `y` to "Cloudflare Access in front of the admin", and give the
   team domain and the AUD tag. With these set the app also checks Access's token on every
   admin request itself, so a request that reaches the Worker some other way is still refused.

After turning it on, make a test card payment and check in Stripe that the webhook was delivered.

**If the admin then refuses you** with "Access token is for a different application", the tag is
the wrong one. Run `npm run setup` again and answer `y` at Access: it shows the stored values in
brackets, and you type the main application's tag over the wrong one. The installer doesn't go
through the admin, so being locked out doesn't stop it.

**The Access email and the app's user are separate.** The audit log names the app's user, and
adds the Access email beside it when the two differ.

**Two other callers can't sign in through Access.** Neither has been tried with Access on.

- The send-agent relay, if you run that program, calls `api/agent` and downloads from
  `api/design` on the admin hostname. Leave Access off, or give those two paths the same kind of
  bypass application as the Stripe one. Each checks its own secret.
- The by-hand roll-up call in [operations.md](operations.md) has to go to one of your shop
  hostnames instead of the admin hostname.

### Vendor connections (PromoStandards)

Tools → **Vendor integrations** fetches product data, your prices and images straight from suppliers
that offer PromoStandards web services (S&S Activewear, SanMar, OTTO Cap and many more). Each vendor
gives you a login for them (ask their web services or EDI team). The logins are stored encrypted, under
a key only your site has. Make it once:

```bash
openssl rand -hex 32 | npx wrangler secret put VENDOR_CREDENTIALS_KEY
```

Keep it: a new key makes the saved logins unreadable, and they'd have to be entered again. Without the
key, Vendor integrations says so and nothing else changes; you can still import a vendor's product
file (Blanks → Import → Vendor product file — new blanks…).

---

## GitHub (optional)

**You don't need a GitHub account to install.** The code can be cloned or downloaded without
one, and the running site never talks to GitHub.

GitHub is only used if you want the **nightly database backup**
([operations.md](operations.md#backups)), which runs from a repository of your own:

1. Create a new, empty, **private** repository. **Don't use the Fork button**: a fork of a
   public repository is public and can't be made private, and your copy will hold your
   `wrangler.toml` with your database id and hostnames.
2. Push your installed copy to it, including your `wrangler.toml`. Your copy also carries this
   project's own "Test suite" check, which expects an untouched `wrangler.toml` and so fails on
   an installed one. Turn it off in your copy: **Actions → Test suite → ⋯ → Disable workflow**.
3. Create the private backup bucket: `npx wrangler r2 bucket create opendecodesk-db-backups`.
4. Create the backup token ([above](#creating-a-cloudflare-api-token)).
5. In the repository go to **Settings → Secrets and variables → Actions**.
   - Under **Secrets** add `CLOUDFLARE_API_TOKEN` (the token) and `CLOUDFLARE_ACCOUNT_ID`
     (your Account ID). Both go under Secrets.
   - Under **Variables** add `D1_BACKUP_ENABLED` with the value `true`. This one goes under
     Variables; under Secrets it does nothing.
6. Start "Nightly D1 backup" by hand from the **Actions** tab, read its log, and check a file
   appeared in the bucket.

Without GitHub you can still back up by hand: create the bucket (step 3), then run
`CLOUDFLARE_ACCOUNT_ID=<your account id> npm run db:backup:now`. See
[operations.md](operations.md#backups).

---

## Every value, in one place

| Value | From | Looks like | Shown once? | Goes into |
|---|---|---|---|---|
| Command-line sign-in | `npx wrangler login` | (nothing to copy) | — | Your computer |
| `STRIPE_SECRET_KEY` | Stripe → API keys | `sk_test_…` / `sk_live_…` | Live keys you create: yes | Installer |
| `STRIPE_WEBHOOK_SECRET` | Stripe → Webhooks → your destination | `whsec_…` | No | Installer, second run |
| `SHIPPO_API_KEY` | Shippo → Developer keys | `shippo_test_…` / `shippo_live_…` | Yes | Installer |
| `RESEND_API_KEY` | Resend → API keys | `re_…` | Yes | Installer |
| `EMAIL_FROM` | You choose it | `orders@<your domain>` | — | Installer |
| `CF_EMAIL_API_TOKEN` | Cloudflare → API Tokens | a long string | Yes | Installer |
| `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY` | Cloudflare → Turnstile → your widget | two strings | No | Installer, together |
| `ACCESS_TEAM_DOMAIN` | Cloudflare → Zero Trust | `<team>.cloudflareaccess.com` | No | Installer |
| `ACCESS_AUD` | The main Access application's settings (not the bypass one) | a long string | No | Installer |
| `CF_API_TOKEN` | Cloudflare → API Tokens | a long string | Yes | Installer |
| `VENDOR_CREDENTIALS_KEY` | You make it (`openssl rand -hex 32`) | 64 hex characters | — | `npx wrangler secret put` |
| `CF_ACCOUNT_ID` | Cloudflare dashboard | letters and digits | No | Installer |
| `CF_ZONE_ID` | Your domain's Overview page | letters and digits | No | Installer |
| `R2_PUBLIC_BASE` | The images bucket's custom domain | `https://images.<your domain>` | — | Installer, later run |
| `CLOUDFLARE_API_TOKEN` | Cloudflare → API Tokens | a long string | Yes | GitHub secret |
| `CLOUDFLARE_ACCOUNT_ID` | Same value as `CF_ACCOUNT_ID` | letters and digits | No | GitHub secret |
| `D1_BACKUP_ENABLED` | You type it | `true` | — | GitHub variable |

The installer makes three values itself and you never fetch them: the admin passphrase (shown to
you once, at the end; the first sign-in with it creates the first admin, who chooses their own
password), the signing secret and the roll-up key. What each value does is in
[configuration.md](configuration.md).

Its first questions are your own answers, not values to fetch: your domain, the subdomain for
the admin, the business name, the owner's email and the time zone
([setup.md](setup.md#the-installer)). Its last question is the send-agent relay, for a separate
program that is not published yet: press Enter. Answering yes makes a fourth value,
`AGENT_TOKEN`, shown once at the end.

**Changing a value later:** run `npm run setup` again and answer `y` to that service. Pressing
Enter at a secret that is already stored keeps it. By hand, it depends on the kind of value:

- A secret (every key, token and signing secret you gave the installer, except the Turnstile
  site key): `npx wrangler secret put NAME`.
- A plain setting (`EMAIL_FROM`, `TURNSTILE_SITE_KEY`, `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`,
  `CF_ACCOUNT_ID`, `CF_ZONE_ID`, `R2_PUBLIC_BASE`): edit it in the installer's `[vars]` block in
  `wrangler.toml`, then `npm run deploy`.

The three backup values are changed in the GitHub repository's settings, not here. Never put a
secret in `wrangler.toml` or in any file in the repository.

---

## Going live

When testing is done, swap the test values for live ones.

**Stripe**

1. Finish Stripe's business verification and add the bank account it pays out to.
2. Switch the dashboard out of the sandbox and copy the live secret key (`sk_live_…`).
3. Add a **new** webhook destination in live mode: the same address, Snapshot, the same seven
   events. Its signing secret is **different** from the sandbox one.
4. Run `npm run setup` and give **both** new values in that one run. Changing only one stops
   payments being recorded.
5. Don't test live mode with a real card; Stripe's terms don't allow it. Watch the first real
   card order instead: it should be delivered with status 200 and the order should read paid.
6. In the admin, **Finance → Accounts & money**: set the account Stripe pays out to.
7. Delete or disable the sandbox webhook destination; its calls will now fail.

**Shippo**

1. Add a payment method and get a live key (`shippo_live_…`). Shippo may review the request, so
   do this a few days before you plan to ship.
2. Run `npm run setup` again and give the live key. Check a quote, then buy the first real label
   on a real order.

**Resend** has one kind of key; there is nothing to switch.
