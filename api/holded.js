/**
 * /api/holded  —  Holded accounting sync for Food Studio OS
 *
 * POST /api/holded/pos-report
 *      Sends a daily POS/EOD summary to Holded as journal entries
 *      Body: { restaurant, date, revenue_food, revenue_wine, revenue_bar,
 *               revenue_softdrinks, revenue_tips, revenue_other,
 *               cogs_food, cogs_wine, cogs_bar, cogs_other, actual_covers }
 *
 * GET  /api/holded/health?restaurant=taller
 *      Checks if the Holded API key for this restaurant is valid
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
  const action   = url.pathname.split('/').pop(); // 'pos-report' | 'health' | 'categorize'
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
  if (restaurant === 'bistro_mondo') return process.env.HOLDED_API_KEY_BISTRO_MONDO || null;
  return process.env.HOLDED_API_KEY_TALLER || process.env.HOLDED_API_KEY || null;
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
