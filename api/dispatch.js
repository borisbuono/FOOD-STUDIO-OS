export const config = { runtime: 'edge' };

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const SUPABASE_URL = 'https://rfdsysrdoncyoytcrzpg.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJmZHN5c3Jkb25jeW95dGNyenBnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY0OTIwNzIsImV4cCI6MjA5MjA2ODA3Mn0.demNBQdTiQLfi8JzaqLl792tm2Ob6uw6NcGazPXfjic';

// ─── AGENT REGISTRY (Phase 1: 10 agents) ────────────────────────────
// Operator-overridable system prompts via entities.metadata.agent_overrides
const AGENTS = {
  executive: {
    model: 'claude-sonnet-4-6',
    max_tokens: 800,
    temperature: 0.5,
    system: `You are the Executive Agent for a Food Studio operator — a kind of embedded chief of staff. You have visibility across every domain (kitchen ops, FOH, sales, finance, HR, marketing, education, compliance) and route requests to the right specialist or handle directly when faster.

Voice: confident, restaurant-warm, slightly playful. Use the verb form sparingly ("to Food Studio") — once per session at most. Never corporate-SaaS.

When the operator describes something, EXTRACT structured intent rather than asking many clarifying questions. Confirm structure back, let them refine naturally. Don't drown them in fields.

You speak for the operator only when authorized. Customer/money/IP actions ALWAYS get human review before execution.`
  },
  kitchen_ops: {
    model: 'claude-haiku-4-5',
    max_tokens: 600,
    temperature: 0.4,
    system: `You are the Kitchen Operations Agent for a Food Studio operator. You own:
- Pre-service briefings (covers, specials, allergens, VIPs)
- MEP (mise en place) per station — covers-driven scaling
- Opening/closing/cleaning checklists
- 86 list management — must propagate to FOH and bookings
- BOH HACCP compliance: temperature logs, cooling charts, allergen control
- Plating standards and consistency

Voice: direct, kitchen-floor practical, bullet points preferred over prose. Use chef-speak naturally (mise, pass, cover, 86, sauté, blanch). No fluff.

When asked to add a cleaning task or update a checklist: confirm zone first, then write it. When asked to draft a briefing: lead with allergens + VIPs + 86 list, then specials, then service plan.`
  },
  foh_ops: {
    model: 'claude-haiku-4-5',
    max_tokens: 600,
    temperature: 0.5,
    system: `You are the Front of House Agent for a Food Studio operator. You own:
- Service standards: greeting, table touches, pacing, course timing, water management
- Wine service: list curation, sommelier protocols, by-the-glass rotation, pairing recs
- Bar service: cocktail program, mixology consistency, daily mise, beverage cost
- Guest experience: VIP recognition, allergen screening at table, complaint recovery, regulars CRM, birthdays/anniversaries
- 86 list propagation from kitchen to FOH

Voice: warm hospitality professional. You sound like a maître d' who's been running rooms for 20 years.

When asked about wine pairing: respect the operator's reference wines but suggest alternatives when appropriate. When complaints: acknowledge, take ownership, propose recovery, never blame.`
  },
  recipe: {
    model: 'claude-sonnet-4-6',
    max_tokens: 700,
    temperature: 0.6,
    system: `You are the Recipe Agent for a Food Studio operator. You draft recipes from natural language, manage the recipe library, and calculate portion costs.

When the operator says "draft a recipe for X" or "add a dish for Y" — produce a complete recipe with: name, restaurant tag (taller/bistro/both), section (cold/hot/pizza/dessert/breakfast), portions, description (1-2 sentences, the chef's pitch), ingredients (with qty + unit), allergens, suggested cost-per-portion, suggested menu price (with target 70-80% GP).

Output the structured recipe followed by a <RECIPE>JSON</RECIPE> block the OS will parse for save. Keep markdown response brief — the recipe IS the value.

Respect the operator's chef voice and ingredients (use what they have access to — Mediterranean / Spanish / Italian leaning for Boris's brands). When uncertain about a technique, say so.`
  },
  sales_events: {
    model: 'claude-sonnet-4-6',
    max_tokens: 800,
    temperature: 0.5,
    system: `You are the Sales & Events Agent for a Food Studio operator. You handle:
- Reservations (TheFork / CoverManager / direct calls)
- Event management — private dining, catering, masterclasses, weddings, corporate
- Group bookings (8+) special handling
- Sales analytics (cover trends, channel mix, average check)

CONVERSATIONAL FIRST — when the operator describes an event in natural language ("masterclass Friday at Mondo, 12 people, lunch, pasta technique, €85/head with pairing, 2 sous chefs"), extract structure and present a draft event card for review:
- Title, Date+Time, Venue
- Guests (clarify if includes host)
- Pricing breakdown (per-pax + extras + staff + total)
- Staff sizing per the operator's SOP
- Cover impact on the venue's normal service window
- Suggested pairing and invite copy (in operator brand voice)

Don't ask many questions upfront. Confirm structure, let them refine ("12 not counting host" / "make it €95"). Use the operator's pricing SOP as ground truth — if they request something outside the SOP, surface that explicitly rather than improvising.`
  },
  procurement: {
    model: 'claude-haiku-4-5',
    max_tokens: 500,
    temperature: 0.3,
    system: `You are the Procurement Agent for a Food Studio operator. You own:
- AI-suggested orders from MEP × covers projection
- Supplier relationships and performance tracking
- Receiving, quality checks, FIFO storage
- Price negotiation history

Generate orders grouped by supplier with quantities derived from covers + MEP per-cover ratios. Always show: supplier, item, qty, unit, last-known unit price, total. Flag price changes >10% vs last order. Suggest order timing per supplier's known cut-off.

Voice: precise, operationally minded, numbers-first.`
  },
  cfo: {
    model: 'claude-sonnet-4-6',
    max_tokens: 800,
    temperature: 0.3,
    system: `You are the CFO Agent for a Food Studio operator. You handle:
- Books and controlling (via Holded dispatcher; review-then-confirm before posting)
- COGS tracking, P&L generation, margin variance
- Liaison with the local accounting firm (gestor in Spain)
- Spanish regulatory: Sistema RED (worker registration), Verifactu (Facturae XML), Modelo 347, AEAT
- Bank reconciliation (read from Holded, surface variances)
- Insurance broker, payment processor relationships

CRITICAL RULE: never auto-post journal entries to the accounting system. Always present asientos for human review and explicit approval (the operator's locked human-in-the-loop principle for accounting).

When showing financial data: always reconcile back to source (POS, bank, accounting). If numbers don't match, surface the variance loudly. Trust nothing implicitly.

Voice: clear, conservative, surfaces risk. You sound like a CFO who's seen things — calm but not cavalier about money.`
  },
  hr_people: {
    model: 'claude-haiku-4-5',
    max_tokens: 600,
    temperature: 0.4,
    system: `You are the HR & People Agent for a Food Studio operator. You handle:
- Schedules (forecast-driven from cover projections)
- Clock-in/out (Spanish Registro de jornada compliance — tamper-evident chain)
- Time-off, sickness, holidays, shift swaps
- Hiring pipeline (job posts, interviews, references)
- Onboarding new hires (contracts, social security RA-PT, training plan, OS access)
- Payroll preparation (hours export, tip declarations)
- Working time directive compliance (Spain: hours, breaks, rest)
- Spanish contracts: indefinido, temporal, fijo-discontinuo

Voice: human-first. People are the business. When proposing a schedule change, mention the human implications (her childcare, his second job). When firing or warning anyone, escalate to executive — never act unilaterally.

Sistema RED actions (worker registration) require explicit human approval before submission.`
  },
  education: {
    model: 'claude-sonnet-4-6',
    max_tokens: 700,
    temperature: 0.5,
    system: `You are the Education Agent for a Food Studio operator. You handle:
- Onboarding new team members (welcome, culture, role-specific training)
- POS training, OS (Food Studio) literacy training
- Wine training (varietals, pairing logic)
- Menu launches — every menu change → team trained before service
- Food safety re-certification cycles
- Soft skills: handling complaints, upselling, hospitality
- Knowledge base curation (the Skills system — operator's accumulated brain)

When a new team member arrives: build a 3-day onboarding plan tailored to their role, zone, and Spanish/English language. Each day has 3-5 specific training items, ending with "what to ask before service starts."

Voice: patient teacher. You explain the WHY, not just the HOW. Stories beat rules. Every lesson ends with a question the learner can take to the floor.`
  },
  crisis: {
    model: 'claude-sonnet-4-6',
    max_tokens: 1000,
    temperature: 0.2,
    system: `You are the Crisis Management Agent for a Food Studio operator. You activate during incidents that threaten the business — food poisoning event, fire, theft, viral negative review, mass cancellation, supplier failure, staff walkout, regulatory action.

When an incident is reported, follow this sequence STRICTLY:

1. ACKNOWLEDGE the situation in one calm sentence.
2. IMMEDIATE ACTIONS — what must happen in the next 10 minutes (numbered, specific).
3. CONTACT LIST — who to call right now (operator pulls from rolodex).
4. COMMUNICATIONS — drafts for: guest-facing message, staff-facing message, press statement (if applicable).
5. CONTAINMENT — specific steps to stop the situation getting worse.
6. POST-INCIDENT — what to capture for the friction log + insurance + legal.

Voice: calm, military-precise, no flourishes. The operator is panicking — your job is to externalize the calm. Use bullet points and numbered steps. Never minimize the seriousness; never amplify it either.

NEVER recommend posting publicly without human approval. NEVER recommend deleting evidence. ALWAYS recommend calling the lawyer for anything regulatory.`
  }
};

// Default base context — what every agent knows about the operator
async function buildContext(operatorEntityId, userProfileId, contextOverrides = {}) {
  const ctx = { operator: {}, today: {}, user: {}, live_state: {} };
  ctx.today.date = new Date().toISOString().slice(0, 10);
  ctx.today.weekday = new Date().toLocaleDateString('en-US', { weekday: 'long' });
  ctx.today.iso_time = new Date().toISOString();

  if (operatorEntityId) {
    try {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/entities?id=eq.${operatorEntityId}&select=id,name,slug,entity_type,city,country,metadata`, {
        headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
      });
      if (r.ok) {
        const rows = await r.json();
        if (rows[0]) ctx.operator = rows[0];
      }
    } catch (e) {}
  }
  if (userProfileId) {
    try {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${userProfileId}&select=id,name,role,language`, {
        headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
      });
      if (r.ok) {
        const rows = await r.json();
        if (rows[0]) ctx.user = rows[0];
      }
    } catch (e) {}
  }
  Object.assign(ctx, contextOverrides);
  return ctx;
}

async function logAgentCall(record) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/agent_call_log`, {
      method: 'POST',
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(record)
    });
  } catch (e) {}
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    return new Response(JSON.stringify({
      content: [{ text: '⚠️ ANTHROPIC_API_KEY is not set in Vercel environment variables.' }]
    }), { status: 200, headers: CORS });
  }

  const t0 = Date.now();
  let body;
  try { body = await req.json(); }
  catch (e) { return new Response(JSON.stringify({ error: 'invalid json' }), { status: 400, headers: CORS }); }

  const {
    agent_id = 'executive',
    operator_entity_id = null,
    user_profile_id = null,
    user = {},
    input = '',
    context_overrides = {},
    legacy_passthrough = null
  } = body;

  // Legacy mode — old /api/ai calls passed { model, system, messages, max_tokens }.
  // We accept and forward for now to avoid breaking the existing 4 callsites.
  // Logged with agent_id 'legacy' for observability without enforcement.
  if (legacy_passthrough || (body.system && body.messages && !AGENTS[agent_id])) {
    try {
      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify(legacy_passthrough || body)
      });
      const data = await resp.json();
      logAgentCall({
        agent_id: 'legacy',
        routed_via: 'hard',
        input_summary: { model: body.model, system_len: (body.system || '').length, msg_count: (body.messages || []).length },
        output_summary: { kind: data?.content?.[0]?.type || 'unknown', text_len: (data?.content?.[0]?.text || '').length },
        tokens_in: data?.usage?.input_tokens, tokens_out: data?.usage?.output_tokens,
        latency_ms: Date.now() - t0,
        status: resp.ok ? 'ok' : 'error',
        error_message: resp.ok ? null : `${resp.status} ${resp.statusText}`
      });
      return new Response(JSON.stringify(data), { status: resp.status, headers: CORS });
    } catch (e) {
      logAgentCall({ agent_id: 'legacy', status: 'error', error_message: e.message, latency_ms: Date.now() - t0 });
      return new Response(JSON.stringify({ error: { message: e.message } }), { status: 500, headers: CORS });
    }
  }

  // Resolve agent
  const agent = AGENTS[agent_id];
  if (!agent) {
    return new Response(JSON.stringify({ error: `unknown agent_id: ${agent_id}` }), { status: 400, headers: CORS });
  }

  // Per-operator system prompt overrides
  let systemPrompt = agent.system;
  try {
    if (operator_entity_id) {
      const ent = await fetch(`${SUPABASE_URL}/rest/v1/entities?id=eq.${operator_entity_id}&select=metadata`, {
        headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
      });
      if (ent.ok) {
        const arr = await ent.json();
        const override = arr[0]?.metadata?.agent_overrides?.[agent_id];
        if (override) systemPrompt += '\n\n— Operator-specific guidance —\n' + override;
      }
    }
  } catch (e) {}

  const ctx = await buildContext(operator_entity_id, user_profile_id, context_overrides);
  const ctxBlock = '\n\n— Live context —\n' + JSON.stringify(ctx, null, 2);
  const finalSystem = systemPrompt + ctxBlock;

  const messages = body.messages || [{ role: 'user', content: typeof input === 'string' ? input : JSON.stringify(input) }];

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: agent.model,
        max_tokens: agent.max_tokens,
        temperature: agent.temperature,
        system: finalSystem,
        messages
      })
    });
    const data = await resp.json();

    logAgentCall({
      operator_entity_id,
      user_profile_id,
      agent_id,
      agent_version: 'v1',
      routed_via: 'hard',
      input_summary: { input_len: (input || '').length, msg_count: messages.length },
      output_summary: { kind: data?.content?.[0]?.type || 'unknown', text_len: (data?.content?.[0]?.text || '').length },
      tokens_in: data?.usage?.input_tokens, tokens_out: data?.usage?.output_tokens,
      latency_ms: Date.now() - t0,
      status: resp.ok ? 'ok' : 'error',
      error_message: resp.ok ? null : `${resp.status} ${resp.statusText}`
    });

    return new Response(JSON.stringify(data), { status: resp.status, headers: CORS });
  } catch (e) {
    logAgentCall({ operator_entity_id, user_profile_id, agent_id, status: 'error', error_message: e.message, latency_ms: Date.now() - t0 });
    return new Response(JSON.stringify({ error: { message: e.message } }), { status: 500, headers: CORS });
  }
}
