# Security

## Reporting a vulnerability

**Please don't open a public issue for a security problem.**

Use the **private vulnerability reporting** feature of the site that hosts this repository (on
the repository's page, under its Security section, "Report a vulnerability"). That sends the
report privately to the maintainers.

Please include:

- what the problem is and what someone could do with it,
- how to reproduce it (a request, a sequence of steps, or a failing test),
- which version (commit) you looked at.

This is a volunteer project with no paid security team, so there is no promised response time and
no bounty. Reports are read and taken seriously, and you will be credited in the fix unless you
would rather not be.

If private reporting isn't available on the copy of the repository you are looking at, open an
issue that says only "I have a security report" and asks for a private way to send it — with no
details in the issue itself.

## What is in scope

Problems in **this repository's code**, for example:

- one shop's customers or data being visible from another shop's address, or from the root domain;
- reaching an admin action without signing in, from a non-admin address, or around two-step
  sign-in;
- paying less than an order's real price, or changing a price, tax or shipping amount from the
  browser;
- reading a private file (a receipt, a design file) without a valid signed link;
- script injection through something a customer or an admin can type or upload;
- a secret being returned to a browser, written to a log, or printed by the installer;
- forging or replaying a Stripe webhook;
- getting around the rate limits on sign-in in a way that makes guessing practical;
- the installer (`scripts/setup.mjs`) writing a secret somewhere it shouldn't, or running a command
  built from unescaped input.

The design this is measured against is described in
[docs/architecture.md](docs/architecture.md#the-security-model).

## What is out of scope

- **Your own install's configuration**: a weak passphrase, a leaked API token, a bucket you made
  public, DNS records, Cloudflare account settings.
- **Things only a signed-in admin can do to their own install.** The admin is trusted; there is
  one admin role.
- **Cloudflare, Stripe, Shippo, Resend** and other services themselves — report those to them.
- **The send-agent**, which is a separate project.
- Denial of service by sheer volume. (A cheap way to make the site do expensive work *is* worth
  reporting.)
- Missing hardening with no demonstrated impact — with one known exception worth saying out loud:
  the Content Security Policy allows inline scripts (`'unsafe-inline'`). That is a known limit of
  how the pages are written, not a new finding; a working injection is still very much in scope.

## Supported versions

There are no numbered releases yet. Fixes are made on the main branch.

## For people running an install

- Turn on two-step sign-in (Security → Security (2FA)) — the passphrase alone is one shared secret.
- Keep `wrangler.toml` with your ids out of public repositories, and never commit a secret.
- Keep the receipts, designs and database-backup buckets private.
- Give each Cloudflare API token only the permissions it needs.
- Read the morning roll-up: it reports failed sign-in attempts.
