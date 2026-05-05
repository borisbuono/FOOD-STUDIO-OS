// /api/dispatch.js — v3 (multi-provider: Anthropic + Google Gemini, fetch-only, no SDKs)
//
// Replaces api_dispatch_v2.js with direct fetch calls (no @anthropic-ai/sdk, no @google/genai).
// Adds:
//   - skill parameter → loads agent_skills row via Supabase PostgREST, uses its system_prompt + schemas
//   - provider routing (anthropic | google) → calls the right API endpoint
//   - automatic fallback (provider error → retry on fallback_provider)
//   - structured logging into agent_call_log with provider + skill_code + confidence + sources
//
// Required Vercel env vars:
//   ANTHROPIC_API_KEY (existing)
//   GEMINI_API_KEY    (NEW — get from https://aistudio.google.com/apikey)
//   SUPABASE_URL      (existing)
//   SUPABASE_SERVICE_ROLE_KEY (existing — service role for log writes)
//
// Edge runtime — no imports, native fetch only.

export const config = { runtime: 'edge' };

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// ----- 10-agent base registry (unchanged) — kept for back-compat with calls without skill -----
const AGENTS = {
  executive: {
    model: 'claude-sonnet-4-6',
    temperature: 0.5,
    max_tokens: 4096,
    system: 'You are the Executive Agent at Food Studio OS — Boris\'s operating partner. You orchestrate the specialist agents and reply to cross-domain asks with synthesized answers. Stay terse, specific, ground claims in data, surface sources.',
  },
  kitchen_ops: {
    model: 'claude-sonnet-4-6',
    temperature: 0.4,
    max_tokens: 3072,
    system: 'You are the Kitchen Ops expert at Food Studio. Generate briefings, MEP plans, 86 lists, allergen alerts, pass-down notes. Style: terse bullets, kitchen-floor language, no hospitality fluff.',
  },
  foh_ops: {
    model: 'claude-sonnet-4-6',
    temperature: 0.4,
    max_tokens: 3072,
    system: 'You are the FOH Ops expert at Food Studio. Owns covers, allergens, VIPs, cellar service, table flow. Style: warm-professional, hospitality polish.',
  },
  recipe: {
    model: 'claude-sonnet-4-6',
    temperature: 0.6,
    max_tokens: 4096,
    system: 'You are the Recipe expert at Food Studio. Draft, cost, version, allergen-tag and CCP-tag recipes. Style: working-chef, technique-led, terse.',
  },
  sales_events: {
    model: 'claude-sonnet-4-6',
    temperature: 0.5,
    max_tokens: 4096,
    system: 'You are the Sales & Events expert at Food Studio. Inquiries → proposals → confirmation → BEO → execution → close. Voice: hospitality-refined, warm, confident, specific.',
  },
  procurement: {
    model: 'claude-sonnet-4-6',
    temperature: 0.3,
    max_tokens: 3072,
    system: 'You are the Procurement expert at Food Studio. Drafts supplier orders, reconciles deliveries, flags variances, suggests substitutes.',
  },
  cfo: {
    model: 'claude-sonnet-4-6',
    temperature: 0.3,
    max_tokens: 3072,
    system: 'You are the CFO expert at Food Studio. Reconciles POS to accounting (human-in-loop always), forecasts cash, categorises expenses, prepares close.',
  },
  hr_people: {
    model: 'claude-sonnet-4-6',
    temperature: 0.3,
    max_tokens: 3072,
    system: 'You are the HR & People expert at Food Studio. Schedule, jornada, payroll, absence, training, onboarding. Spanish labour law context.',
  },
  compliance: {
    model: 'claude-sonnet-4-6',
    temperature: 0.2,
    max_tokens: 3072,
    system: 'You are the Compliance / HACCP expert at Food Studio. Owns Plan de Autocontrol (Libro Azul), temperature logs, traceability, training expiries, inspection-readiness. Spanish AESAN + Balearic Consellería de Sanitat context.',
  },
  education: {
    model: 'claude-sonnet-4-6',
    temperature: 0.5,
    max_tokens: 3072,
    system: 'You are the Education expert at Food Studio. Designs curriculum, schedules training, tracks skill progression, generates quizzes, grounded in the operator\'s lexicon.',
  },
  crisis: {
    model: 'claude-sonnet-4-6',
    temperature: 0.2,
    max_tokens: 2048,
    system: 'You are the Crisis expert at Food Studio. Detects anomalies (HACCP violations, financial irregularities, scheduling collapses, supplier failures), escalates, drafts incident reports, coordinates response.',
  },
};

// Maps skill agent_id → agent_code for logging
const AGENT_BY_ID = {
  executive: 'executive',
  kitchen_ops: 'kitchen_ops',
  foh_ops: 'foh_ops',
  recipe: 'recipe',
  sales_events: 'sales_events',
  procurement: 'procurement',
  cfo: 'cfo',
  hr_people: 'hr_people',
  compliance: 'compliance',
  education: 'education',
  crisis: 'crisis',
};

// ----- Cost estimator (rough, EUR per call) ----------------------------------
const PRICING_PER_MTOK = {
  'claude-sonnet-4-6':       { in: 3.00, out: 15.00 },
  'claude-haiku-4-5-20251001': { in: 0.80, out: 4.00 },
  'gemini-2.5-pro':          { in: 1.25, out: 10.00 },
  'gemini-2.0-flash':        { in: 0.10, out: 0.40 },
};

function estimateCostEur({ model, input_tokens, output_tokens }) {
  const p = PRICING_PER_MTOK[model];
  if (!p) return null;
  const usd = (input_tokens * p.in + output_tokens * p.out) / 1_000_000;
  return Number((usd * 0.92).toFixed(4)); // USD→EUR rough
}

function truncateSummary(text, maxChars = 500) {
  if (!text) return '';
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + '...';
}

// ----- Anthropic API call (fetch-only) -----
async function callAnthropic({ apiKey, model, system, messages, temperature, max_tokens }) {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      system,
      messages,
      temperature,
      max_tokens,
    }),
  });

  if (!resp.ok) {
    const errData = await resp.text();
    throw new Error(`Anthropic API error: ${resp.status} ${errData}`);
  }

  const data = await resp.json();
  const text = data.content
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('\n');

  return {
    text,
    provider: 'anthropic',
    request_id: data.id,
    usage: {
      input_tokens: data.usage?.input_tokens || 0,
      output_tokens: data.usage?.output_tokens || 0,
    },
  };
}

// ----- Gemini API call (fetch-only) -----
async function callGemini({ apiKey, model, system, messages, temperature, max_tokens }) {
  const contents = messages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }],
  }));

  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contents,
        systemInstruction: system,
        generationConfig: {
          temperature,
          maxOutputTokens: max_tokens,
        },
      }),
    }
  );

  if (!resp.ok) {
    const errData = await resp.text();
    throw new Error(`Gemini API error: ${resp.status} ${errData}`);
  }

  const data = await resp.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  const usage = data.usageMetadata || {};

  return {
    text,
    provider: 'google',
    request_id: data.candidates?.[0]?.finishMessage || null,
    usage: {
      input_tokens: usage.promptTokenCount || 0,
      output_tokens: usage.candidatesTokenCount || 0,
    },
  };
}

// ----- Supabase PostgREST query helper -----
async function supabaseQuery(supabaseUrl, serviceRoleKey, table, filter, select = '*') {
  const url = new URL(`${supabaseUrl}/rest/v1/${table}`);
  url.searchParams.set('select', select);
  for (const [key, value] of Object.entries(filter)) {
    url.searchParams.set(`${key}=eq.${encodeURIComponent(value)}`);
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
    throw new Error(`Supabase query error: ${resp.status}`);
  }

  const data = await resp.json();
  return Array.isArray(data) ? data : [data];
}

// ----- Supabase PostgREST insert helper (fire-and-forget) -----
function supabaseInsert(supabaseUrl, serviceRoleKey, table, row) {
  const url = new URL(`${supabaseUrl}/rest/v1/${table}`);

  // Fire-and-forget: don't await
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
    // Silently log errors to console (Vercel Edge logs)
    console.error(`Supabase insert failed for ${table}:`, err.message);
  });
}

// ----- Main handler ---------------------------------------------------------
export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'method_not_allowed' }), {
      status: 405,
      headers: CORS,
    });
  }

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const geminiKey = process.env.GEMINI_API_KEY;
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!anthropicKey || !geminiKey || !supabaseUrl || !supabaseServiceRoleKey) {
    return new Response(
      JSON.stringify({
        error: 'missing_env_vars',
        detail: 'ANTHROPIC_API_KEY, GEMINI_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY required',
      }),
      { status: 500, headers: CORS }
    );
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'bad_json' }), { status: 400, headers: CORS });
  }

  const {
    agent,
    skill,
    input,
    messages: inMessages,
    operator_entity_id,
    restaurant_id,
    user_id,
  } = body;

  const callId = crypto.randomUUID();
  const startedAt = Date.now();

  // 1. Resolve agent + (optional) skill config
  let agentConfig;
  let skillRow = null;
  let agentCode = null;

  if (skill) {
    try {
      const skillRows = await supabaseQuery(
        supabaseUrl,
        supabaseServiceRoleKey,
        'agent_skills',
        { skill_code: skill, is_active: 'true' }
      );

      if (!skillRows || skillRows.length === 0) {
        return new Response(
          JSON.stringify({ error: 'unknown_skill', skill }),
          { status: 400, headers: CORS }
        );
      }

      skillRow = skillRows[0];
      agentCode = AGENT_BY_ID[skillRow.agent_id] || skillRow.agent_id;
      const baseAgent = AGENTS[skillRow.agent_id] || {};

      agentConfig = {
        provider: skillRow.provider || 'anthropic',
        model: skillRow.model || baseAgent.model || 'claude-sonnet-4-6',
        system: skillRow.system_prompt,
        temperature: skillRow.temperature ?? baseAgent.temperature ?? 0.4,
        max_tokens: skillRow.max_tokens || baseAgent.max_tokens || 4096,
        fallback_provider: skillRow.fallback_provider,
        fallback_model: skillRow.fallback_model,
        requires_review: skillRow.human_review_required || false,
      };
    } catch (err) {
      return new Response(
        JSON.stringify({ error: 'skill_lookup_failed', detail: err.message }),
        { status: 500, headers: CORS }
      );
    }
  } else if (agent && AGENTS[agent]) {
    agentCode = AGENT_BY_ID[agent] || agent;
    agentConfig = {
      provider: 'anthropic',
      ...AGENTS[agent],
      fallback_provider: 'google',
      fallback_model: 'gemini-2.5-pro',
    };
  } else {
    return new Response(
      JSON.stringify({ error: 'agent_or_skill_required' }),
      { status: 400, headers: CORS }
    );
  }

  // 2. Operator context (lightweight)
  let context = '';
  if (operator_entity_id) {
    try {
      const entRows = await supabaseQuery(
        supabaseUrl,
        supabaseServiceRoleKey,
        'entities',
        { id: operator_entity_id },
        'id,name,slug,metadata'
      );

      if (entRows && entRows.length > 0) {
        const ent = entRows[0];
        context = `\n\n<operator_context>\n${ent.name} (${ent.slug})\n${JSON.stringify(ent.metadata || {}, null, 0)}\n</operator_context>`;
      }
    } catch (err) {
      // Continue without context on error
      console.warn('Failed to fetch operator context:', err.message);
    }
  }

  const systemFinal = agentConfig.system + context;

  // 3. Build messages
  const messages = inMessages || [
    {
      role: 'user',
      content: typeof input === 'string' ? input : JSON.stringify(input),
    },
  ];

  // 4. Try primary provider, fall back if needed
  let result = null;
  let fellBack = false;
  let lastError = null;

  try {
    if (agentConfig.provider === 'google') {
      result = await callGemini({
        apiKey: geminiKey,
        model: agentConfig.model,
        system: systemFinal,
        messages,
        temperature: agentConfig.temperature,
        max_tokens: agentConfig.max_tokens,
      });
    } else {
      result = await callAnthropic({
        apiKey: anthropicKey,
        model: agentConfig.model,
        system: systemFinal,
        messages,
        temperature: agentConfig.temperature,
        max_tokens: agentConfig.max_tokens,
      });
    }
  } catch (err) {
    lastError = err;
    if (agentConfig.fallback_provider && agentConfig.fallback_model) {
      try {
        if (agentConfig.fallback_provider === 'google') {
          result = await callGemini({
            apiKey: geminiKey,
            model: agentConfig.fallback_model,
            system: systemFinal,
            messages,
            temperature: agentConfig.temperature,
            max_tokens: agentConfig.max_tokens,
          });
        } else {
          result = await callAnthropic({
            apiKey: anthropicKey,
            model: agentConfig.fallback_model,
            system: systemFinal,
            messages,
            temperature: agentConfig.temperature,
            max_tokens: agentConfig.max_tokens,
          });
        }
        fellBack = true;
      } catch (err2) {
        return new Response(
          JSON.stringify({
            error: 'all_providers_failed',
            primary: String(err.message || err),
            fallback: String(err2.message || err2),
          }),
          { status: 502, headers: CORS }
        );
      }
    } else {
      return new Response(
        JSON.stringify({ error: 'provider_failed', detail: String(err.message || err) }),
        { status: 502, headers: CORS }
      );
    }
  }

  const latencyMs = Date.now() - startedAt;

  // 5. Try to extract structured fields if output_schema implied JSON
  let parsedOutput = null;
  let confidence = null;
  let sources = null;

  if (skillRow?.output_schema && result) {
    try {
      const jsonMatch =
        result.text.match(/```json\s*([\s\S]+?)\s*```/) ||
        result.text.match(/^\s*(\{[\s\S]+\})\s*$/);

      if (jsonMatch) {
        try {
          parsedOutput = JSON.parse(jsonMatch[1]);
          if (parsedOutput.confidence) confidence = parsedOutput.confidence;
          if (parsedOutput.sources) sources = parsedOutput.sources;
        } catch {
          // Leave as text
        }
      }
    } catch {
      // Ignore
    }
  }

  // 6. Estimate cost
  const costEur = estimateCostEur({
    model: agentConfig.model,
    input_tokens: result?.usage?.input_tokens || 0,
    output_tokens: result?.usage?.output_tokens || 0,
  });

  // 7. Log the call (fire-and-forget)
  const logRow = {
    operator_entity_id: operator_entity_id || null,
    user_profile_id: user_id || null,
    agent_id: agentCode,
    skill_code: skill || null,
    provider: result?.provider || 'unknown',
    provider_request_id: result?.request_id || null,
    input_summary: truncateSummary(typeof input === 'string' ? input : JSON.stringify(input)),
    output_summary: truncateSummary(result?.text || ''),
    cost_cents: costEur ? Math.round(costEur * 100) : null,
    latency_ms: latencyMs,
    confidence: confidence || null,
    sources: sources ? JSON.stringify(sources) : null,
    fell_back: fellBack,
    error_message: lastError ? lastError.message : null,
  };

  supabaseInsert(supabaseUrl, supabaseServiceRoleKey, 'agent_call_log', logRow);

  return new Response(
    JSON.stringify({
      ok: true,
      call_id: callId,
      skill: skill || null,
      agent: agentCode,
      provider: result?.provider || 'unknown',
      model: agentConfig.model,
      fell_back: fellBack,
      latency_ms: latencyMs,
      output: parsedOutput || result?.text || null,
      requires_review: agentConfig.requires_review || false,
      cost_eur: costEur,
    }),
    { status: 200, headers: CORS }
  );
}
