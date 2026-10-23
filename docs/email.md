# Email

The site sends email through **one** provider — never two, and there is no fallback. If a send
fails it is not retried somewhere else; it is recorded as a problem, shown on the admin's
**Communications** page and reported in the next morning roll-up.

With **no provider set up, no email is sent at all.** Orders still work; customers just get no
confirmation, and each attempted email is listed as a problem.

## Choosing a provider

| | Cloudflare Email Service | Resend |
|---|---|---|
| Needs | Cloudflare's **paid Workers plan** | A Resend account |
| Set | `CF_EMAIL_API_TOKEN` (secret) + `CF_ACCOUNT_ID` | `RESEND_API_KEY` (secret) |
| Bounces | A customer address that permanently bounces is reported back at once, and the send counts as failed | Not reported back to the site (Resend reports bounces later, in its own dashboard) |

**If `RESEND_API_KEY` is set, Resend is used for everything**, whatever else is set. To switch back
to Cloudflare, remove that secret.

`npm run setup` asks which one you want and stores the key. By hand: `npx wrangler secret put
RESEND_API_KEY`, or `npx wrangler secret put CF_EMAIL_API_TOKEN` plus `CF_ACCOUNT_ID` in `[vars]`.

For Cloudflare, the API token should have **only** the Email Sending permission. Do not reuse the
token used for automatic hostnames (`CF_API_TOKEN`), which can change your account.

## Verifying your sending domain

Either provider will only send mail **from a domain you have proved is yours**. Until that is done,
every send fails. This is done with the provider, not in OpenDecoDesk, and the site can't check it
for you — the Setup status list only shows whether a key is set.

- **Resend**: add your domain in Resend's dashboard. It gives you DNS records; add them in the
  Cloudflare dashboard (DNS) for your domain and wait for Resend to show the domain as verified.
- **Cloudflare Email Service**: follow Cloudflare's own steps for turning on Email Sending for your
  domain (they are not part of this project, and are not repeated here because they may change).

If your domain already has SPF, DKIM or DMARC records (for example because you send mail from it
with another service), read the provider's instructions carefully — the new records have to be
combined with the old ones, not added alongside.

The domain to verify is the one in the sender address: by default `orders@<your root domain>`,
or whatever you set as `EMAIL_FROM`.

## Who sends, who receives

Every email is sent **from** `EMAIL_FROM` (default `orders@<root domain>`), under your business
name, with **reply-to set to your own inbox** — so a customer who replies reaches you.

| Inbox | Set in | Used for |
|---|---|---|
| **Your inbox** (owner) | Global settings → Business profile → "Your inbox". Falls back to the `OWNER_EMAIL` variable, then `owner@<root domain>`. | The morning roll-up, and the reply-to on every email. Not shown to customers. |
| **Receipts inbox** | Global settings → Business profile → "Receipts inbox", or the `EMAIL_BCC` variable (which wins). Optional. | Gets a hidden copy (BCC) of every email the site sends — skipped when the email is already addressed to that inbox. |
| **Contact email** | Global settings → Business profile → "Contact email". | Shown to customers on the storefront. Not used for sending. |

Make sure "Your inbox" is filled in. If it isn't, notices go to `owner@<root domain>`, which
probably doesn't exist.

## What gets sent

To customers, as things happen:

- **Order received** — when an order is placed.
- **Order confirmed** — when you mark an order paid, or press the order's **Resend** button once it
  is paid. A card payment does not email the customer by itself: it is recorded and reported to you
  in the roll-up. (Stripe can send its own receipt, depending on your Stripe settings.)
- **Your order has shipped** — once, when an order becomes shipped (Shipping feature).
- **Design proof** — when you send a design for approval (Design approval feature).
- **Payment request** — when you email a payment link.
- **Cancellation** — when you cancel items on an order that has an email address.

To you:

- **The morning roll-up** — one email a day with everything new. See
  [operations.md](operations.md).

## Checking it works

The quickest check is Tools → **Communications** → **Send a test email** (admins only). It sends
one short message the same way order emails go, and shows what happened:

- which provider was used, and the From, Reply-to and BCC addresses;
- what the provider answered: its HTTP status and its own message (and, from Resend, the email's id
  to look up on its Logs page);
- whether `RESEND_API_KEY` looks right: its length, that it starts with `re_`, and no stray space or
  line break (the key itself is never shown);
- what to do about the usual problems: the sending domain not verified in Resend, Resend's testing
  mode (it only sends to your own address until a domain is verified), a refused key, or a From
  address still on `example.com` because `ROOT_DOMAIN` isn't set.

A test send is not recorded as a failed email. Up to 10 a minute.

Or place a test order on a shop with your own email address. If nothing arrives:

1. Tools → Global settings → **Setup status**: is Email "Ready", and which provider does it name?
2. Tools → **Communications**: is there a problem listed for that email?
3. In your provider's dashboard: is the domain verified, and does it show the send?
