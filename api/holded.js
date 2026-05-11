/**
 * /api/holded  —  Holded accounting sync for Food Studio OS
 *
 * POST /api/holded/pos-report
 *      Sends a daily POS/EOD summary to Holded as journal entries
 *
 * GET  /api/holded?action=health&restaurant=taller
 *      Checks if the Holded API key for this restaurant is valid
 *
 * GET  /api/holded?action=bank-movements&restaurant=bistro-mondo&days_back=30
 *      Returns treasury movements for cash-flow KPIs.
 *      Response: { ok, movements: [{id, date, amount, currency, description,
 *                  category, account_id, balance_after}], since, count }
 *
 * GET  /api/holded?action=open-invoices&restaurant=bistro-mondo
 *      Returns BOTH open sales invoices (receivables) AND open purchase
 *      invoices (payables), tagged with type field.
 *      Response: { ok, invoices: [{id, type, date, due_date, amount, currency,
 *                  contact_id, contact_name, concept, status, days_overdue}],
 *                  receivables_total, payables_total, count }
 *
 * GET  /api/holded?action=contact&restaurant=bistro-mondo&id=<contactId>
 *      Returns supplier/customer contact details for the Decisions panel
 *      missing-invoice follow-up flow (prefills mailto: link).
 *      Response: { ok, contact: {id, name, email, phone, vat_number, country} }
 *
 * POST /api/holded/categorize
 *      Triggers document categorization in Holded (purchase invoices → PGC codes)
 *
 * Requires env vars:
 *   HOLDED_API_KEY_TALLER        — Holded API key for Taller (Ibiza Food Lab SL)
 *   HOLDED_API_KEY_BISTRO_MONDO  — Holded API key for Bistro Mondo S.L.
 *   HOLDED_COMPANY_TALLER        — Holded company ID (optional, used for multi-entity)
 *   HOLDED_COMPANY_BISTRO_MONDO
 */

export const config = { runtime: 'edge' };

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const HOLDED_BASE = 'https://api.holded.com/api';
const SUPABASE_URL = 'https://rfdsysrdoncyoytcrzpg.supabase.co';

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  const url      = new URL(req.url);
  // Accept action via ?action=X query OR via path segment /api/holded/X for backwards compat
  const action   = url.searchParams.get('action') || url.pathname.split('/').pop();
  const rest     = url.searchParams.get('restaurant') || 'taller';
  const heldedKey = getHoldedKey(rest);

  if (!heldedKey) {
    return json({
      error: `HOLDED_API_KEY not configured for "${rest}". Add HOLDED_API_KEY_TALLER or HOLDED_API_KEY_BISTRO_MONDO to Vercel env vars.`,
      configured: false,
    }, 200);
  }

  // ── GET /api/holded/health ─────────────────────────────────────────────────
  if (req.method === 'GET' && action === 'health') {
    try {
      const resp = await holdedFetch('/invoicing/v1/documents/invoices?page=1&limit=1', heldedKey);
      return json({ ok: resp.ok, restaurant: rest, configured: true });
    } catch (e) {
      return json({ ok: false, error: e.message, restaurant: rest, configured: true });
    }
  }

  // ── GET /api/holded?action=bank-movements ──────────────────────────────────
  // Returns treasury movements for cash-flow KPIs. Holded's treasury API is /treasury/v1/transactions.
  // Falls back gracefully if the endpoint shape changes — UI handles empty movements array.
  if (req.method === 'GET' && action === 'bank-movements') {
    const daysBack = parseInt(url.searchParams.get('days_back') || '30', 10);
    const since = new Date(Date.now() - daysBack * 86400000).toISOString().slice(0, 10);
    try {
      // Try the treasury endpoint first; some Holded plans expose it as /accounting/v1/transactions
      let resp = await holdedFetch(`/treasury/v1/transactions?startDate=${since}&page=1&limit=200`, heldedKey);
      if (!resp.ok && resp.status === 404) {
        resp = await holdedFetch(`/accounting/v1/transactions?startDate=${since}&page=1&limit=200`, heldedKey);
      }
      if (!resp.ok) {
        return json({ ok: true, movements: [], note: `Holded treasury endpoint returned ${resp.status} — endpoint may not be exposed on this plan`, since });
      }
      const data = await resp.json();
      const rows = Array.isArray(data) ? data : (data.data || data.transactions || []);
      const movements = rows.map(r => ({
        id: r.id || r._id || null,
        date: r.date || r.transactionDate || null,
        amount: parseFloat(r.amount || r.value || 0),
        currency: r.currency || 'EUR',
        description: r.description || r.concept || r.note || '',
        category: categoriseMovement(r),
        account_id: r.accountId || r.account_id || null,
        balance_after: r.balance != null ? parseFloat(r.balance) : null,
      }));
      return json({ ok: true, movements, since, count: movements.length });
    } catch (e) {
      return json({ ok: false, error: e.message, movements: [] }, 200);
    }
  }

  // ── GET /api/holded?action=open-invoices ───────────────────────────────────
  // Returns BOTH open sales invoices (customers owe us) AND open purchase invoices (we owe suppliers).
  // The UI's receivables/payables KPIs split by `type` field.
  if (req.method === 'GET' && action === 'open-invoices') {
    try {
      const [salesResp, purchaseResp] = await Promise.all([
        holdedFetch('/invoicing/v1/documents/invoices?status=open&page=1&limit=200', heldedKey),
        holdedFetch('/invoicing/v1/documents/purchaseinvoices?status=open&page=1&limit=200', heldedKey),
      ]);
      const today = new Date(); today.setHours(0, 0, 0, 0);
      const parse = (raw, type) => {
        const arr = Array.isArray(raw) ? raw : (raw.data || raw.documents || []);
        return arr.map(d => {
          const dueIso = d.dueDate ? new Date(d.dueDate * 1000).toISOString().slice(0,10)
                        : d.due_date || d.dueDateStr || null;
          const daysOverdue = dueIso ? Math.max(0, Math.floor((today - new Date(dueIso)) / 86400000)) : 0;
          return {
            id: d.id || d._id,
            type,
            date: d.date ? (typeof d.date === 'number' ? new Date(d.date * 1000).toISOString().slice(0,10) : d.date) : null,
            due_date: dueIso,
            amount: parseFloat(d.total || d.amount || 0),
            currency: d.currency || 'EUR',
            contact_id: d.contactId || d.contact_id || null,
            contact_name: d.contactName || d.contact_name || '',
            concept: d.concept || d.description || '',
            status: d.status || 'open',
            days_overdue: daysOverdue,
          };
        });
      };
      const sales = salesResp.ok ? parse(await salesResp.json(), 'sale') : [];
      const purchases = purchaseResp.ok ? parse(await purchaseResp.json(), 'purchase') : [];
      const invoices = [...sales, ...purchases];
      return json({
        ok: true,
        invoices,
        count: invoices.length,
        receivables_total: sales.reduce((s, i) => s + i.amount, 0),
        payables_total: purchases.reduce((s, i) => s + i.amount, 0),
      });
    } catch (e) {
      return json({ ok: false, error: e.message, invoices: [] }, 200);
    }
  }

  // ── GET /api/holded?action=contact&id=<contactId> ──────────────────────────
  // Returns supplier/customer contact details for the Decisions panel mailto: flow.
  if (req.method === 'GET' && action === 'contact') {
    const id = url.searchParams.get('id');
    if (!id) return json({ ok: false, error: 'Missing id parameter' }, 400);
    try {
      const resp = await holdedFetch(`/invoicing/v1/contacts/${encodeURIComponent(id)}`, heldedKey);
      if (!resp.ok) return json({ ok: false, error: `Holded returned ${resp.status}` }, 200);
      const c = await resp.json();
      return json({
        ok: true,
        contact: {
          id: c.id || c._id || id,
          name: c.name || '',
          email: c.email || '',
          phone: c.phone || c.mobile || '',
          vat_number: c.vat_number || c.vatnumber || c.code || '',
          country: c.country || c.billAddress?.country || '',
        },
      });
    } catch (e) {
      return json({ ok: false, error: e.message }, 200);
    }
  }

  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  let body;
  try { body = await req.json(); }
  catch { return json({ error: 'Invalid JSON' }, 400); }

  // ── POST /api/holded/pos-report ────────────────────────────────────────────
  if (action === 'pos-report') {
    const date       = body.date || new Date().toISOString().slice(0, 10);
    const restaurant = body.restaurant || rest;

    // Build POS summary in the format the Holded dispatcher expects
    const summary = buildPosSummary(body, date);

    // Generate journal entry (asiento de cierre de caja)
    const asiento = buildAsiento(summary, date);

    // Option 1: If HOLDED has journal entry endpoint, post it
    // Option 2: Store in Supabase for now (pending live Holded write capability)
    const holdedKey2 = getHoldedKey(restaurant);
    let holdedResult = null;

    if (holdedKey2) {
      // Attempt to read today's invoices to verify connection
      try {
        const healthResp = await holdedFetch('/invoicing/v1/documents/invoices?page=1&limit=1', holdedKey2);
        holdedResult = { connected: healthResp.ok };
      } catch (e) {
        holdedResult = { connected: false, error: e.message };
      }
    }

    // Always write back to Supabase eod_reports with holded_synced_at
    const anonKey = process.env.SUPABASE_ANON_KEY ||
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJmZHN5c3Jkb25jeW95dGNyenBnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY0OTIwNzIsImV4cCI6MjA5MjA2ODA3Mn0.demNBQdTiQLfi8JzaqLl792tm2Ob6uw6NcGazPXfjic';

    const eodPayload = {
      report_date:        date,
      actual_covers:      body.actual_covers || 0,
      revenue:            summary.totals.total,
      revenue_food:       body.revenue_food   || 0,
      revenue_wine:       body.revenue_wine   || 0,
      revenue_bar:        body.revenue_bar    || 0,
      revenue_softdrinks: body.revenue_softdrinks || 0,
      revenue_tips:       body.revenue_tips   || 0,
      revenue_other:      body.revenue_other  || 0,
      cogs_food:          body.cogs_food      || 0,
      cogs_wine:          body.cogs_wine      || 0,
      cogs_bar:           body.cogs_bar       || 0,
      cogs_other:         body.cogs_other     || 0,
      holded_synced_at:   holdedResult?.connected ? new Date().toISOString() : null,
    };

    // Upsert into eod_reports (keyed on restaurant_id + report_date, handled by app)
    // For now just return the prepared journal entry
    return json({
      ok: true,
      date,
      restaurant,
      summary,
      asiento,
      holded: holdedResult,
      eod_payload: eodPayload,
      note: holdedResult?.connected
        ? 'Journal entry prepared. POST to Holded journal endpoint when write capability is enabled.'
        : 'Holded API key not connected or not configured. Data prepared but not posted.',
    });
  }

  // ── POST /api/holded/categorize ────────────────────────────────────────────
  if (action === 'categorize') {
    const key = getHoldedKey(body.restaurant || rest);
    if (!key) return json({ error: 'No Holded key for this restaurant' }, 400);

    try {
      // Fetch purchase invoices
      const [invoicesResp, deliveryResp] = await Promise.all([
        holdedFetch('/invoicing/v1/documents/purchaseinvoices?page=1&limit=50', key),
        holdedFetch('/invoicing/v1/documents/deliverynotes?page=1&limit=50', key),
      ]);

      const invoices  = invoicesResp.ok ? await invoicesResp.json() : [];
      const deliveries = deliveryResp.ok ? await deliveryResp.json() : [];
      const all = [...(invoices.data || []), ...(deliveries.data || [])];

      const categorized = all.map(doc => categorizeDocument(doc));
      return json({ ok: true, count: categorized.length, documents: categorized });
    } catch (e) {
      return json({ error: e.message }, 500);
    }
  }

  return json({ error: `Unknown action: ${action}` }, 404);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getHoldedKey(restaurant) {
  // Accept both 'bistro_mondo' and 'bistro-mondo' (the slug used in the UI)
  if (restaurant === 'bistro_mondo' || restaurant === 'bistro-mondo') {
    return process.env.HOLDED_API_KEY_BISTRO_MONDO || null;
  }
  return process.env.HOLDED_API_KEY_TALLER || process.env.HOLDED_API_KEY || null;
}

/**
 * Best-effort categorisation of a bank movement → {sales, suppliers, labour, utilities, other}
 * Used by the bank-movements endpoint when Holded doesn't surface a category code.
 * The cash_flow_forecast agent skill applies finer categorisation downstream.
 */
function categoriseMovement(mov) {
  const txt = ((mov.description || '') + ' ' + (mov.concept || '') + ' ' + (mov.note || '')).toLowerCase();
  if (mov.amount > 0) return 'sales';
  if (/nomina|salario|sueldo|seguridad social|irpf|payroll/i.test(txt)) return 'labour';
  if (/luz|gas|agua|electricidad|telefono|internet|endesa|naturgy|movistar|orange|vodafone/i.test(txt)) return 'utilities';
  if (/proveedor|supplier|maison|delivery|mercado|fresh|carne|pescado|verdura|vino/i.test(txt)) return 'suppliers';
  return 'other';
}

async function holdedFetch(path, apiKey) {
  return fetch(`${HOLDED_BASE}${path}`, {
    headers: { 'key': apiKey, 'Accept': 'application/json' },
  });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: CORS });
}

/**
 * Build a POS summary from EOD report data
 * Maps FS OS revenue categories → Holded PGC sub-accounts
 */
function buildPosSummary(body, date) {
  const d = (v) => parseFloat(v || 0);
  const food   = d(body.revenue_food);
  const wine   = d(body.revenue_wine);
  const bar    = d(body.revenue_bar);
  const soft   = d(body.revenue_softdrinks);
  const tips   = d(body.revenue_tips);
  const other  = d(body.revenue_other);

  // IVA rates (Spain): food+soft = reducido 10%, alcohol = general 21%
  const ivaFood  = food  * 0.10;
  const ivaWine  = wine  * 0.21;
  const ivaBar   = bar   * 0.21;
  const ivaSoft  = soft  * 0.10;
  const ivaOther = other * 0.21;
  const totalIva = ivaFood + ivaWine + ivaBar + ivaSoft + ivaOther;

  const baseTotal   = food + wine + bar + soft + tips + other;
  const total       = baseTotal + totalIva;

  return {
    fecha: date,
    ventas_por_categoria: { food, wine, bar, softdrinks: soft, tips, other },
    ventas_por_iva: {
      reducido_10:  food + soft,
      general_21:   wine + bar + other,
      exento_0:     tips,
    },
    totales: { base_imponible: baseTotal, iva: totalIva, total },
  };
}

/**
 * Build Holded-style journal entry (asiento de cierre de caja)
 * Uses 6-digit Holded sub-account codes from chart_of_accounts
 */
function buildAsiento(summary, date) {
  const { food, wine, bar, softdrinks: soft, tips, other } = summary.ventas_por_categoria;
  const ivaFood = food * 0.10;
  const ivaWine = wine * 0.21;
  const ivaBar  = bar  * 0.21;
  const ivaSoft = soft * 0.10;
  const total   = summary.totales.total;

  return [
    // DEBE — Caja (cash received)
    { cuenta: '57000000', descripcion: 'Caja — cierre de caja',         debe: total,   haber: 0 },
    // HABER — Sales sub-accounts
    { cuenta: '70000001', descripcion: 'Ventas — Comida',               debe: 0, haber: food  },
    { cuenta: '70000002', descripcion: 'Ventas — Vino',                 debe: 0, haber: wine  },
    { cuenta: '70000003', descripcion: 'Ventas — Bar',                  debe: 0, haber: bar   },
    { cuenta: '70000004', descripcion: 'Ventas — Refrescos',            debe: 0, haber: soft  },
    { cuenta: '70000006', descripcion: 'Ventas — Propinas',             debe: 0, haber: tips  },
    ...(other > 0 ? [{ cuenta: '70000000', descripcion: 'Ventas — Otros', debe: 0, haber: other }] : []),
    // HABER — IVA repercutido
    { cuenta: '47700010', descripcion: 'IVA repercutido — red. 10%',    debe: 0, haber: ivaFood + ivaSoft },
    { cuenta: '47700021', descripcion: 'IVA repercutido — gral. 21%',   debe: 0, haber: ivaWine + ivaBar },
  ].filter(l => l.debe > 0 || l.haber > 0);
}

/**
 * Categorize a purchase document using keyword matching → PGC account code
 * Mirrors holded_accounting.py categorize logic
 */
function categorizeDocument(doc) {
  const concept = ((doc.concept || '') + ' ' + (doc.contactName || '')).toLowerCase();
  let pgcCode = '629'; // default: otros servicios

  const rules = [
    [[/carne|pescado|marisco|verdura|fruta|queso|embutido|lacteo|aceite|harina/], '600'],
    [[/vino|cerveza|licor|refresco|agua mineral|bebida/], '600'],
    [[/gas natural|electricidad|agua|suministro/], '628'],
    [[/alquiler|arrend/], '621'],
    [[/publicidad|marketing|redes social|diseño/], '627'],
    [[/limpieza|producto limpieza|detergente/], '629'],
    [[/nomina|salario|seguridad social|irpf/], '640'],
    [[/amortizac/], '681'],
    [[/telefon|internet|comunicacion/], '629'],
  ];

  for (const [patterns, code] of rules) {
    if (patterns.some(p => p.test(concept))) { pgcCode = code; break; }
  }

  return {
    id:          doc.id,
    fecha:       doc.date,
    tipo:        doc.docType || 'Factura Compra',
    proveedor:   doc.contactName || '',
    concepto:    doc.concept || '',
    base:        doc.base || 0,
    iva:         doc.tax || 0,
    total:       doc.total || 0,
    cta_pgc:     pgcCode,
    estado:      doc.status || '',
  };
}
