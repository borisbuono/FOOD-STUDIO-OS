# Holded endpoints needed for Cash & Flow (Step 2)

**Filed:** 2026-05-08 · For Boris to wire when he's ready
**Status:** Cash & Flow UI is built and live — currently shows "Awaiting endpoint" placeholders for KPIs sourced from these endpoints. Once you ship them, the UI flips automatically with no client-side changes needed.

The Cash & Flow domain in Office hits four endpoints:
1. `GET /api/holded?action=health&restaurant=<slug>` — **EXISTS** (already in api/holded.js, returns `{ok, configured}`)
2. `POST /api/missing-invoices` — **EXISTS** (already in api/missing-invoices.js, returns `{missing: [...]}`)
3. `GET /api/holded?action=bank-movements&restaurant=<slug>&days_back=30` — **NEEDED** (this brief)
4. `GET /api/holded?action=open-invoices&restaurant=<slug>` — **NEEDED** (this brief)

Plus there's a fifth that the Decisions panel will eventually hit:
5. `GET /api/holded?action=contact&restaurant=<slug>&id=<contactId>` — **NEEDED** (lookup supplier email/phone for missing-invoices follow-up flow)

---

## Endpoint 3: bank-movements

**Route:** `GET /api/holded?action=bank-movements&restaurant=<slug>&days_back=30`

**What the UI sends:** `restaurant` ('taller' or 'bistro-mondo'), `days_back` (numeric, default 30).

**What the UI expects back** (Cash & Flow KPI strip + cash_flow_forecast input):

```json
{
  "ok": true,
  "movements": [
    {
      "id": "mv_abc123",
      "date": "2026-05-08",
      "amount": 234.50,
      "currency": "EUR",
      "description": "Maison Lehmann INV-4421",
      "category": "suppliers",
      "account_id": "...",
      "balance_after": 18420.30
    }
  ]
}
```

**Holded API path:** `/treasury/v1/movements` or `/accounting/v1/movements` (check the docs — Holded's treasury API has the bank movement endpoint). Should support `start_date`/`end_date` query parameters.

**Auth:** same as the existing endpoints — read `getHoldedKey(rest)` from `api/holded.js`.

**Categorisation:** if Holded returns a category code (PGC), map it to one of {`sales`, `suppliers`, `labour`, `utilities`, `other`} per the chart_of_accounts table. If it doesn't, leave `category` empty and the agent_skill will infer.

---

## Endpoint 4: open-invoices

**Route:** `GET /api/holded?action=open-invoices&restaurant=<slug>`

**What the UI expects:**

```json
{
  "ok": true,
  "invoices": [
    {
      "id": "inv_abc",
      "type": "sale",
      "date": "2026-05-04",
      "due_date": "2026-06-03",
      "amount": 1200.00,
      "currency": "EUR",
      "contact_id": "ctc_xyz",
      "contact_name": "Hideaways Group",
      "concept": "Villa catering — Saturday dinner service",
      "status": "open",
      "days_overdue": 0
    }
  ]
}
```

**Holded API path:** `/invoicing/v1/documents/invoices?status=open` for sales invoices, `/invoicing/v1/documents/purchases?status=open` for purchase invoices. Combine into one array with `type` field set to `'sale'` or `'purchase'` per source.

**Important:** include both customer-side (sales, where guests/clients owe us) AND supplier-side (purchases, where we owe suppliers). The cash_flow_forecast skill needs both.

---

## Endpoint 5: contact lookup (for later — Decisions panel needs it)

**Route:** `GET /api/holded?action=contact&restaurant=<slug>&id=<contactId>`

**What the UI expects:**

```json
{
  "ok": true,
  "contact": {
    "id": "ctc_xyz",
    "name": "Maison Lehmann",
    "email": "comptes@maison-lehmann.fr",
    "phone": "+33 1 ...",
    "vat_number": "FR12345678901",
    "country": "FR"
  }
}
```

**Holded API path:** `/invoicing/v1/contacts/<id>`.

**Why needed:** when the Decisions panel surfaces a missing-invoice card ("Maison Lehmann delivered Friday, no invoice in 4 days"), the operator wants to email the supplier. This endpoint provides the contact email so the action button can prefill a `mailto:` link.

---

## How the UI degrades gracefully today

The frontend `loadOwsCashFlow()` already wraps each fetch in try/catch + treats non-200 as "awaiting endpoint." So:

- Health badge: shows "Holded connected" if `/api/holded?action=health` returns ok, else status-appropriate variant
- Today's revenue / 30-day balance KPI cards: show "—" with subtitle "Awaiting bank-movements endpoint" until endpoint 3 lands
- Open receivables / payables: show "—" with subtitle "Awaiting open-invoices endpoint" until endpoint 4 lands
- Cash-flow narrative: shows muted placeholder text until both 3 + 4 are wired (cash_flow_forecast skill needs both)
- Missing invoices list: real today via existing `/api/missing-invoices`
- Reconcile / Categorise / Open Holded buttons: all functional today

When you ship endpoints 3 and 4, no client code changes — the next page reload reads real data automatically.

---

## Suggested implementation order

1. **Endpoint 3 (bank-movements)** — biggest unlock. Today's revenue + 30-day balance light up + cash_flow_forecast can run in dry-run mode (just bank, no invoices yet)
2. **Endpoint 4 (open-invoices)** — receivables + payables KPIs go live, cash_flow_forecast becomes accurate
3. **Endpoint 5 (contact lookup)** — needed for the missing-invoices follow-up flow in Decisions panel

Cash & Flow is fully functional once 3 and 4 ship. 5 is for the Decisions panel polish.

---

## Estimated time

If Holded's REST docs are correct and the auth pattern in `api/holded.js` is already working: ~30 min per endpoint, ~2 hours total. Each is a thin Edge function that calls Holded REST and reshapes the response to match the schema above.

The hardest part is figuring out which Holded endpoint provides bank movements (their docs are fragmented). Once you find it, the rest is mechanical.
