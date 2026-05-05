// /api/nightly-digest.js — runs nightly via Vercel Cron, fetch-only (no SDKs)
// Uses Gemini 2.5 Pro's 2M-token context to read the entire OS state
// and produce a single executive digest for Boris's morning.
//
// Output is written to:
//   - inbox_items (one card per high-priority finding)
//   - agent_call_log (for audit + costing)
//
// Required env vars:
//   GEMINI_API_KEY
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//   CRON_SECRET (random string — Vercel sends this in the X-Cron-Secret header)
//
// Schedule via vercel.json:
//   { "crons": [{ "path": "/api/nightly-digest", "schedule": "0 6 * * *" }] }   // 06:00 UTC daily
//
// Way 2 of Boris's Gemini integration:
// long-context summary so each new working session starts grounded in full state.

export const config = { runtime: 'edge' };

const DIGEST_PROMPT = `You are the Food Studio OS Executive Briefer.
Your job is to read the operator's full OS state and produce a one-page digest for the morning.

Your output is a JSON object with these fields (all required, even if empty):
{
  "headline": "one sentence — the most important thing to know first thing today",
  "wins": ["list of 2-4 wins from the past 24h — completed events, shipped features, positive feedback"],
  "risks": ["list of 2-4 active risks needing attention this week"],
  "today_priority": "what to focus on today, one paragraph",
  "this_week_focus": "what to focus on this week, one paragraph",
  "decisions_pending": [{"id": "...", "summary": "...", "deadline": "..."}],
  "agents_status": {
    "highest_value_call": "the most valuable agent call from the past 24h, summarised",
    "friction_signal": "any friction events to address",
    "cost_24h_eur": <number>
  },
  "kpi_pulse": {
    "covers_yesterday": <number_or_null>,
    "events_this_week": <number>,
    "haccp_compliance_pct": <number>,
    "supplier_orders_pending": <number>
  },
  "rec": ["3 specific actions Boris should take today, in priority order"]
}

Be terse, specific, ground claims. Use the brand voice — hospitality-refined, warm, confident.
Pull from the corpus below. Do not hallucinate. If a number is missing, write null. If unsure, write "unknown" instead of guessing.`;

function tokenEstimate(text) {
  // Rough: ~3.5 chars per token for English + Spanish mix
  return Math.ceil(text.length / 3.5);
}

// ----- Supabase PostgREST query helper (with limit) -----
async function supabaseQuery(supabaseUrl, serviceRoleKey, table, filter = {}, select = '*', limit = 200) {
  const url = new URL(`${supabaseUrl}/rest/v1/${table}`);
  url.searchParams.set('select', select);

  for (const [key, value] of Object.entries(filter)) {
    if (Array.isArray(value)) {
      // Array value: ["gte", "2026-05-01"] → gte filter
      if (value.length === 2) {
        url.searchParams.set(`${key}=${value[0]}.${encodeURIComponent(value[1])}`);
      }
    } else if (typeof value === 'object' && value !== null && 'op' in value && 'val' in value) {
      // Object: {op: "neq", val: "archived"} → neq filter
      url.searchParams.set(`${key}=${value.op}.${encodeURIComponent(value.val)}`);
    } else {
      // Simple equality
      url.searchParams.set(`${key}=eq.${encodeURIComponent(value)}`);
    }
  }

  if (limit) {
    url.searchParams.set('limit', limit);
  }

  const resp = await fetch(url.toString(), {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      'apikey': serviceRoleKey,
      'Authorization': `Bearer ${serviceRoleKey}`,
    },
  });

  if (!resp.ok) {
    throw new Error(`Supabase query error on ${table}: ${resp.status}`);
  }

  const data = await resp.json();
  return Array.isArray(data) ? data : [data];
}

// ----- Supabase PostgREST insert helper (fire-and-forget) -----
function supabaseInsert(supabaseUrl, serviceRoleKey, table, row) {
  const url = new URL(`${supabaseUrl}/rest/v1/${table}`);

  // Fire-and-forget
  fetch(url.toString(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': serviceRoleKey,
      'Authorization': `Bearer ${serviceRoleKey}`,
      'Prefer': 'return=minimal',
    },
    body: JSON.stringify(row),
  }).catch(err => {
    console.error(`Supabase insert failed for ${table}:`, err.message);
  });
}

// ----- Gemini API call (fetch-only) -----
async function callGemini({ apiKey, model, system, corpus, temperature = 0.4, maxOutputTokens = 4096 }) {
  const corpusJson = JSON.stringify(corpus, null, 2);

  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [{ text: `Corpus:\n\`\`\`json\n${corpusJson}\n\`\`\`` }],
          },
        ],
        systemInstruction: system,
        generationConfig: {
          temperature,
          maxOutputTokens,
        },
      }),
    }
  );

  if (!resp.ok) {
    const errData = await resp.text();
    throw new Error(`Gemini API error: ${resp.status} ${errData}`);
  }

  const data = await resp.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
  const usage = data.usageMetadata || {};

  return {
    text,
    provider: 'google',
    usage: {
      input_tokens: usage.promptTokenCount || 0,
      output_tokens: usage.candidatesTokenCount || 0,
    },
  };
}

// ----- Main handler ---------------------------------------------------------
export default async function handler(req) {
  // Cron auth — header-only (Vercel best practice)
  const cronSecret = req.headers.get('x-cron-secret');
  if (cronSecret !== process.env.CRON_SECRET) {
    return new Response(JSON.stringify({ error: 'forbidden' }), { status: 401 });
  }

  const geminiKey = process.env.GEMINI_API_KEY;
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!geminiKey || !supabaseUrl || !supabaseServiceRoleKey) {
    return new Response(
      JSON.stringify({
        error: 'missing_env_vars',
        detail: 'GEMINI_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY required',
      }),
      { status: 500 }
    );
  }

  const startedAt = Date.now();
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const weekEnd = new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10);

  let corpus = {};
  let operatorId = null;

  try {
    // 1. Build the corpus — anything that helps Gemini paint a full picture.
    const [
      entitiesData,
      restaurantsData,
      eventsUpcomingData,
      eventsPastData,
      inboxData,
      haccpPlansData,
      tempLogsData,
      agentCallsData,
      frictionData,
      ordersData,
      coversData,
    ] = await Promise.all([
      supabaseQuery(supabaseUrl, supabaseServiceRoleKey, 'entities', {}, 'id,name,slug,entity_type,metadata', 50),
      supabaseQuery(supabaseUrl, supabaseServiceRoleKey, 'restaurants', {}, 'id,name,slug,lat,lng,clock_in_radius_m', 20),
      supabaseQuery(supabaseUrl, supabaseServiceRoleKey, 'sales_events', { event_date: ['gte', today], event_date: ['lte', weekEnd] }, 'id,title,event_type,status,event_date,guests_count,estimated_revenue,estimated_gp_pct', 100),
      supabaseQuery(supabaseUrl, supabaseServiceRoleKey, 'sales_events', { event_date: ['lt', today], event_date: ['gte', since7d] }, 'id,title,event_type,status,event_date,actual_revenue,actual_gp_pct', 50),
      supabaseQuery(supabaseUrl, supabaseServiceRoleKey, 'inbox_items', { status: { op: 'neq', val: 'archived' } }, 'id,category,subject,priority,status,created_at,sender', 100),
      supabaseQuery(supabaseUrl, supabaseServiceRoleKey, 'haccp_plans', { status: 'active' }, 'id,plan_code,plan_name,status,next_review_due,restaurant_id'),
      supabaseQuery(supabaseUrl, supabaseServiceRoleKey, 'haccp_temperature_logs', { measured_at: ['gte', since24h] }, 'id,equipment_name,temperature_c,is_within_range,measured_at,restaurant_id', 200),
      supabaseQuery(supabaseUrl, supabaseServiceRoleKey, 'agent_call_log', { created_at: ['gte', since24h] }, 'id,agent_id,skill_code,provider,cost_cents,latency_ms,confidence,requires_review,reviewed_at,created_at', 200),
      supabaseQuery(supabaseUrl, supabaseServiceRoleKey, 'friction_log', { created_at: ['gte', since7d] }, 'id,skill_code,rating,correction,created_at', 100),
      supabaseQuery(supabaseUrl, supabaseServiceRoleKey, 'orders', { created_at: ['gte', since7d] }, 'id,provider_id,status,total,delivery_date,created_at', 100),
      supabaseQuery(supabaseUrl, supabaseServiceRoleKey, 'covers', { date: yesterday }, 'restaurant_id,covers_count,date', 50),
    ]);

    const operator = entitiesData.find(e => e.entity_type === 'holding_company');
    if (operator) {
      operatorId = operator.id;
    }

    corpus = {
      generated_at: new Date().toISOString(),
      operator: operator || null,
      restaurants: restaurantsData || [],
      upcoming_events: eventsUpcomingData || [],
      recent_past_events: eventsPastData || [],
      inbox_open: inboxData || [],
      haccp_plans: haccpPlansData || [],
      temp_logs_24h: tempLogsData || [],
      agent_calls_24h: agentCallsData || [],
      friction_7d: frictionData || [],
      orders_7d: ordersData || [],
      covers_yesterday: coversData || [],
    };
  } catch (err) {
    return new Response(
      JSON.stringify({
        error: 'corpus_fetch_failed',
        detail: err.message,
      }),
      { status: 500 }
    );
  }

  // 2. Call Gemini 2.5 Pro with the entire corpus
  let digest = {};
  let geminiLatencyMs = 0;

  try {
    const result = await callGemini({
      apiKey: geminiKey,
      model: 'gemini-2.5-pro',
      system: DIGEST_PROMPT,
      corpus,
      temperature: 0.4,
      maxOutputTokens: 4096,
    });

    geminiLatencyMs = Date.now() - startedAt;

    try {
      digest = JSON.parse(result.text);
    } catch {
      // If JSON parse fails, store raw text
      digest = { error: 'parse_failed', body: result.text };
    }
  } catch (err) {
    return new Response(
      JSON.stringify({
        error: 'gemini_call_failed',
        detail: err.message,
      }),
      { status: 502 }
    );
  }

  // 3. Write the digest record to inbox
  const dateKey = today;
  const digestId = crypto.randomUUID();

  supabaseInsert(supabaseUrl, supabaseServiceRoleKey, 'inbox_items', {
    id: digestId,
    operator_entity_id: operatorId,
    category: 'nightly_digest',
    source: 'nightly_digest',
    subject: `Morning digest · ${dateKey}`,
    sender_name: 'Food Studio OS',
    sender_handle: 'executive',
    body: JSON.stringify(digest.headline || 'Morning digest'),
    metadata: digest,
    received_at: new Date().toISOString(),
    status: 'new',
    priority: 'normal',
  });

  // 4. Surface high-risk items as separate inbox cards if Gemini flagged any
  if (digest.risks && Array.isArray(digest.risks)) {
    for (const risk of digest.risks) {
      if (typeof risk === 'string' && /urgent|critical|today/i.test(risk)) {
        supabaseInsert(supabaseUrl, supabaseServiceRoleKey, 'inbox_items', {
          id: crypto.randomUUID(),
          operator_entity_id: operatorId,
          category: 'agent_escalation',
          source: 'nightly_digest',
          subject: 'Risk flagged in morning digest',
          sender_name: 'Food Studio OS',
          sender_handle: 'executive',
          body: risk,
          metadata: { risk },
          received_at: new Date().toISOString(),
          priority: 'high',
          status: 'new',
        });
      }
    }
  }

  const latencyMs = Date.now() - startedAt;
  const corpusSize = JSON.stringify(corpus).length;

  // 5. Log the digest call itself
  supabaseInsert(supabaseUrl, supabaseServiceRoleKey, 'agent_call_log', {
    operator_entity_id: operatorId,
    user_profile_id: null,
    agent_id: 'executive',
    skill_code: 'nightly_digest',
    provider: 'google',
    provider_request_id: null,
    input_summary: `corpus_size_bytes=${corpusSize}`,
    output_summary: `digest_with_${digest.wins?.length || 0}_wins_${digest.risks?.length || 0}_risks`,
    cost_cents: null,
    latency_ms: latencyMs,
    confidence: null,
    sources: null,
    fell_back: false,
    error_message: digest.error || null,
  });

  return new Response(
    JSON.stringify({
      ok: true,
      digest_id: digestId,
      risks_created: digest.risks?.filter(r => /urgent|critical|today/i.test(r)).length || 0,
      latency_ms: latencyMs,
      corpus_kb: Math.round(corpusSize / 1024),
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
}
