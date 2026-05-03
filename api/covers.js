/**
 * /api/covers  —  Booking system webhook + covers read endpoint
 *
 * GET  /api/covers?restaurant=taller&date=2026-05-03
 *      Returns today's cover rows for the app to display
 *
 * POST /api/covers
 *      Accepts cover data from any booking system (or manual entry)
 *      Body format depends on `source` field — see normalizeCovers()
 *
 * Supported sources: thefork · sevenrooms · resy · covermanager ·
 *                    opentable · hotel_pms · google_sheets · manual · webhook
 */

export const config = { runtime: 'edge' };

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Webhook-Secret, X-Source',
};

const SUPABASE_URL = 'https://rfdsysrdoncyoytcrzpg.supabase.co';

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  const anonKey   = process.env.SUPABASE_ANON_KEY ||
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJmZHN5c3Jkb25jeW95dGNyenBnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY0OTIwNzIsImV4cCI6MjA5MjA2ODA3Mn0.demNBQdTiQLfi8JzaqLl792tm2Ob6uw6NcGazPXfjic';

  // ── GET — read covers for a restaurant + date ──────────────────────────────
  if (req.method === 'GET') {
    const url        = new URL(req.url);
    const restaurant = url.searchParams.get('restaurant') || 'taller';
    const date       = url.searchParams.get('date') || new Date().toISOString().slice(0, 10);

    const resp = await fetch(
      `${SUPABASE_URL}/rest/v1/covers?restaurant=eq.${encodeURIComponent(restaurant)}&service_date=eq.${date}&select=*&order=service_type.asc`,
      { headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}` } }
    );
    const data = await resp.json();
    return new Response(JSON.stringify(data), { status: 200, headers: CORS });
  }

  // ── POST — receive booking system webhook ──────────────────────────────────
  if (req.method === 'POST') {
    // Webhook secret validation (optional but recommended)
    const webhookSecret = process.env.COVERS_WEBHOOK_SECRET;
    if (webhookSecret) {
      const incoming = req.headers.get('x-webhook-secret');
      if (incoming !== webhookSecret) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: CORS });
      }
    }

    let body;
    try { body = await req.json(); }
    catch { return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400, headers: CORS }); }

    const source   = body.source || req.headers.get('x-source') || 'webhook';
    const writeKey = serviceKey || anonKey; // prefer service key for writes

    // Normalize covers from any booking system format
    const rows = normalizeCovers(body, source);
    if (!rows.length) {
      return new Response(JSON.stringify({ error: 'No usable cover data in payload' }), { status: 400, headers: CORS });
    }

    // Upsert (restaurant + service_date + service_type is the unique key)
    const resp = await fetch(`${SUPABASE_URL}/rest/v1/covers`, {
      method: 'POST',
      headers: {
        apikey: writeKey,
        Authorization: `Bearer ${writeKey}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=representation',
      },
      body: JSON.stringify(rows),
    });

    if (!resp.ok) {
      const err = await resp.text();
      return new Response(JSON.stringify({ error: err }), { status: 500, headers: CORS });
    }

    const saved = await resp.json();
    return new Response(JSON.stringify({ ok: true, rows: saved }), { status: 200, headers: CORS });
  }

  return new Response('Method not allowed', { status: 405 });
}

/**
 * Normalize any booking system's payload into an array of cover rows
 * matching the `covers` table schema.
 */
function normalizeCovers(body, source) {
  const today = new Date().toISOString().slice(0, 10);

  // ── TheFork (La Fourchette) ────────────────────────────────────────────────
  // TheFork sends individual booking events; aggregate by date+shift
  if (source === 'thefork') {
    const bookings = body.bookings || (body.booking ? [body.booking] : [body]);
    const map = {};
    for (const b of bookings) {
      const date   = (b.date || b.booking_date || today).slice(0, 10);
      const shift  = b.shift === 'LUNCH' ? 'lunch' : 'dinner';
      const rest   = slugify(b.restaurant_name || b.venue_name || 'taller');
      const key    = `${rest}_${date}_${shift}`;
      if (!map[key]) map[key] = { restaurant: rest, service_date: date, service_type: shift, pax: 0, source: 'thefork', source_ref: b.booking_id || null };
      map[key].pax += parseInt(b.num_guests || b.party_size || 0);
    }
    return Object.values(map);
  }

  // ── SevenRooms ────────────────────────────────────────────────────────────
  if (source === 'sevenrooms') {
    const reservations = body.reservations || [body];
    const map = {};
    for (const r of reservations) {
      const date = (r.date || today).slice(0, 10);
      const rest = slugify(r.venue_name || r.venue_id || 'taller');
      const key  = `${rest}_${date}_dinner`;
      if (!map[key]) map[key] = { restaurant: rest, service_date: date, service_type: 'dinner', pax: 0, source: 'sevenrooms', source_ref: null };
      map[key].pax += parseInt(r.party_size || r.covers || 0);
    }
    return Object.values(map);
  }

  // ── CoverManager ──────────────────────────────────────────────────────────
  if (source === 'covermanager') {
    return [{
      restaurant:    slugify(body.restaurant || 'taller'),
      service_date:  (body.date || today).slice(0, 10),
      service_type:  body.service || 'dinner',
      pax:           parseInt(body.pax || body.covers || 0),
      source:        'covermanager',
      source_ref:    body.id || null,
      notes:         body.notes || null,
    }];
  }

  // ── OpenTable ─────────────────────────────────────────────────────────────
  if (source === 'opentable') {
    return [{
      restaurant:    slugify(body.restaurant_name || 'taller'),
      service_date:  (body.booking_date || today).slice(0, 10),
      service_type:  'dinner',
      pax:           parseInt(body.party_size || 0),
      source:        'opentable',
      source_ref:    body.reservation_id || null,
    }];
  }

  // ── Hotel PMS (generic — Mews, Opera, Cloudbeds, etc.) ───────────────────
  if (source === 'hotel_pms') {
    return [{
      restaurant:    slugify(body.outlet || body.restaurant || 'taller'),
      service_date:  (body.date || today).slice(0, 10),
      service_type:  body.meal_period || body.service_type || 'dinner',
      pax:           parseInt(body.expected_covers || body.pax || 0),
      source:        'hotel_pms',
      source_ref:    body.ref || null,
      notes:         body.notes || null,
    }];
  }

  // ── Google Sheets webhook (Zapier/Make automation) ────────────────────────
  if (source === 'google_sheets') {
    return [{
      restaurant:    slugify(body.restaurant || 'taller'),
      service_date:  (body.date || today).slice(0, 10),
      service_type:  (body.service || 'dinner').toLowerCase(),
      pax:           parseInt(body.covers || body.pax || 0),
      source:        'google_sheets',
      source_ref:    body.sheet_row || null,
      notes:         body.notes || null,
    }];
  }

  // ── Manual / generic fallback ─────────────────────────────────────────────
  return [{
    restaurant:    slugify(body.restaurant || 'taller'),
    service_date:  (body.date || today).slice(0, 10),
    service_type:  (body.service_type || body.service || 'dinner').toLowerCase(),
    pax:           parseInt(body.pax || body.covers || 0),
    source:        source === 'manual' ? 'manual' : 'webhook',
    source_ref:    body.ref || body.id || null,
    notes:         body.notes || null,
  }];
}

// Map a venue name to 'taller' or 'bistro_mondo'
function slugify(name) {
  const n = (name || '').toLowerCase();
  if (n.includes('mondo') || n.includes('bistro')) return 'bistro_mondo';
  return 'taller';
}
