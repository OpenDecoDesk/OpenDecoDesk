# Sales tax

OpenDecoDesk handles the simple case: **one rate, charged on orders in your home state.** It is a
record-keeping aid, not tax advice — check what applies to you with your state and your accountant.

**A new install collects no sales tax** until you set a rate.

## The settings

Tools → Global settings → **Sales tax**:

- **Rate** — a percentage, 0 to 15.
- **Home state** — the 2-letter code of the state you collect tax for. (With Region → country
  `OTHER`, it is your region's name as free text.)
- **Prices include sales tax**, or **sales tax is added at checkout.**

Changing any of them affects **new orders only**. Every order keeps the rate, the mode and its
shop's exemption as they were when it was placed, so past reports don't change.

## Prices that include tax, or tax added on top

The tax is worked out **once per line of an order** (not per item), in whole cents.

**Prices include sales tax** (the default). The customer pays the listed price; the tax is the part
of it that is tax.

> A $16.00 cap at 6%: the customer pays **$16.00**. Of that, $15.09 is the sale and **$0.91** is tax.
> Three of them on one line ($48.00): $45.28 sale and **$2.72** tax.

**Sales tax is added at checkout.** The listed price is the sale; the tax is added to it.

> A $20.00 shirt at 7.25%: tax is **$1.45**, the customer pays **$21.45**.
> Three of them on one line ($60.00): tax is **$4.35**, the customer pays $64.35.

The two modes agree with each other: a $15.09 price with 6% added comes to $16.00 with $0.91 tax —
the same sale and the same tax as a $16.00 tax-included price.

The storefront tells the customer which it is: "Prices include 7.25% CA sales tax", or the tax shown
as its own line in the cart. Receipts and the order in the admin show the tax either way.

Because each order remembers its own mode, a reporting period that contains both kinds still adds up.

## What is taxed

A line of an order is taxed when **all** of these are true:

1. **The product is taxable.** Each product has a "taxable" setting (on by default). Turn it off for
   work that isn't taxable where you are. A custom line on a local sale chooses for itself.
2. **The shop is not tax-exempt** (below).
3. **The order is not shipped to another state.** An order with no shipping address — pickup, or
   one of a shop's own delivery options — counts as in your home state. If no home state is set,
   nothing counts as out of state.

Also:

- **Shipping and delivery fees are never taxed.**
- **A discount** reduces the tax in proportion to the taxable goods it was taken off.
- **Cancelled lines** carry no tax.
- **A refund** takes back its share of the tax, in the month it was refunded. You can say how much
  of a refund was shipping (which carried no tax).
- If you change an order — add or edit a line, change the discount, change the address — its tax is
  worked out again from **that order's own** rate and mode.

In the US, the ship-to state has to agree with the ZIP Code (the state decides the tax, so an
address can't claim another state to avoid it). See "ZIP Codes and states" in the README.

## Tax-exempt shops

A shop (a school, a charity, a government body) can be marked tax-exempt: Manage catalog → the shop
→ Edit → Sales tax. It needs the **certificate number**; an expiry date is optional, and the admin
warns you when it has passed. Orders for an exempt shop carry no tax, and the certificate details
are never sent to the storefront.

## The reports

**Reports → Sales Tax Report**, for any range of months:

- The totals for the period: tax collected, tax refunded, use tax, and what is due.
- A month-by-month table laid out like a state sales and use tax return: gross sales, the amounts
  taken off for exempt shops, out-of-state orders and non-taxable items, taxable sales, and tax.
- A breakdown by month, taxable or exempt, and ship-to state.

Things to know when reading it:

- It is on an **accrual basis**: an order counts in the month it was **placed**, paid or not.
- **Months are UTC months**, whatever your time zone (see "Region" in the README).
- Test orders and voided orders are left out.
- **Use tax**: an expense in a category marked "use-taxable", where you say the vendor did not
  charge sales tax, is counted as use tax owed at the current rate (Finance → Expenses, with the
  Bookkeeping feature on).

**Reports → Periods & Export** (Bookkeeping feature) produces the accountant's CSV files, which
include the sales tax collected and refunded per month.

## What it does not do

- Local (city or county) rates on top of the state rate.
- Collecting another state's tax on orders shipped there (destination-based tax).
- Taxed shipping.
- VAT or GST rules. Outside the US you still get one rate and one home region, nothing more.
- Filing anything. The report gives you the numbers to put on your return.
