// /api/missing-invoices.js
// Called by the OS Office tab. Calls Holded REST API directly.
// Returns deliveries without matching invoices for the past N days.

export const config = { runtime: 'edge' };

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS, GET',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: CORS });
}

async function holdedGet(path, holdedKey) {
  const url = `https://api.holded.com/api/invoicing/v1${path}`;
  const r = await fetch(url, { headers: { 'key': holdedKey, 'Accept': 'application/json' } });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`Holded ${r.status}: ${text.slice(0, 200)}`);
  }
  return await r.json();
}

function isApproxMatch(delivery, invoice) {
  // Same supplier (contactId)
  if (delivery.contactId && invoice.contactId && delivery.contactId !== invoice.contactId) return false;
  if (delivery.contactName && invoice.contactName) {
    const a = delivery.contactName.toLowerCase().trim();
    const b = invoice.contactName.toLowerCase().trim();
    if (a !== b && !a.includes(b) && !b.includes(a)) return false;
  }
  // Date within ±14 days
  if (delivery.date && invoice.date) {
    const dDelivery = Number(delivery.date);
    const dInvoice = Number(invoice.date);
    if (!isNaN(dDelivery) && !isNaN(dInvoice)) {
      const days = Math.abs(dDelivery - dInvoice) / 86400;
      if (days > 14) return false;
    }
  }
  // Amount within ±10% (or both within €5)
  const aTotal = Number(delivery.total || 0);
  const bTotal = Number(invoice.total || 0);
  if (aTotal > 0 && bTotal > 0) {
    const diff = Math.abs(aTotal - bTotal);
    const pct = diff / aTotal;
    if (pct > 0.10 && diff > 5) return false;
  }
  return true;
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  const holdedKey = process.env.HOLDED_API_KEY;
  if (!holdedKey) {
    return jsonResponse({
      ok: false,
      error: 'HOLDED_API_KEY not configured in Vercel environment variables. Add it in Vercel → Settings → Environment Variables → Production.',
      missing: [],
      summary: 'No Holded API key set.'
    });
  }

  let body = {};
  if (req.method === 'POST') {
    try { body = await req.json(); } catch(e) {}
  }
  const daysBack = Number(body.days_back || 90);
  const sinceUnix = Math.floor((Date.now() - daysBack * 86400000) / 1000);

  try {
    // Fetch in parallel
    const [deliveries, invoices] = await Promise.all([
      holdedGet(`/documents/deliverynotes?starttmp=${sinceUnix}`, holdedKey),
      holdedGet(`/documents/purchaseinvoices?starttmp=${sinceUnix}`, holdedKey),
    ]);

    // Both Holded responses are arrays
    const dList = Array.isArray(deliveries) ? deliveries : (deliveries.docs || []);
    const iList = Array.isArray(invoices) ? invoices : (invoices.docs || []);

    // For each delivery, check if any invoice matches
    const missing = [];
    for (const d of dList) {
      const matched = iList.some(i => isApproxMatch(d, i));
      if (!matched) {
        missing.push({
          delivery_ref: d.docNumber || d.numSerie || d.number || '(no ref)',
          supplier: d.contactName || '(unknown supplier)',
          delivery_date: d.date ? new Date(Number(d.date) * 1000).toISOString().slice(0,10) : '?',
          amount: Number(d.total || 0).toFixed(2),
          supplier_email: d.contactEmail || '',
          contact_id: d.contactId || null
        });
      }
    }

    // Sort by date descending
    missing.sort((a, b) => (b.delivery_date || '').localeCompare(a.delivery_date || ''));

    return jsonResponse({
      ok: true,
      missing,
      total_deliveries: dList.length,
      total_invoices: iList.length,
      missing_count: missing.length,
      days_back: daysBack,
      summary: `Found ${missing.length} delivery note${missing.length === 1 ? '' : 's'} without matching invoice in the last ${daysBack} days. Total deliveries scanned: ${dList.length}. Total invoices: ${iList.length}.`
    });
  } catch (e) {
    return jsonResponse({
      ok: false,
      error: e.message,
      missing: [],
      summary: 'Holded API call failed: ' + e.message
    }, 500);
  }
}
