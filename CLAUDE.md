# Food Studio OS — Project Context

> Read this file before taking any action in this project.
> This is the master context document for all CoWork agents and sessions.
> **Last refreshed: 2026-05-07** (was severely stale — see "Refresh history" below).

---

## WHAT THIS IS

**Food Studio OS** is a kitchen operating system for restaurant groups.
It runs as a single-page web app (one HTML file) deployed on Vercel,
backed by Supabase for persistence, with Vercel Edge Functions for AI dispatch + integrations.

- Live URL: **https://foodstudio.ai** (also resolves at https://food-studio-os.vercel.app)
- Local preview: `python3 -m http.server 3000` from `/Users/admin/foodstudio/`
- Repo: `git@github.com:borisbuono/FOOD-STUDIO-OS.git` (main = production)

---

## ENTITIES IN THE SYSTEM

The OS is now multi-entity-aware via the `entities` table. Slugs and `R` index for legacy single-tenant code:

| Slug | Display name | Legal entity | Type | R index |
|---|---|---|---|---|
| `taller-sa-penya` | Taller Sa Penya | Ibiza Food Lab SL | operating_venue | R=0 |
| `bistro-mondo` | Bistro Mondo | Bistro Mondo S.L. | operating_venue | R=1 |
| `boris-buono-holdings` | Boris Buono Holdings | Boris Buono Holding SL | holding_company | — |

Plus 5 consultancy clients (Il Buco, Can Quince, Escondido, Zanzibar project, Egypt project), 4 partners (Cocorito Group, Es Vedra Bay Villas, Giri Residence, Hideaways), 1 supplier (Maison Lehmann).

Brand architecture (locked 2026-05-03): product brand = "Food Studios" (plural). Boris's operator instance is "Ibiza Food Studios". Future product co = "Food Studio OS SL". Naming pattern for new operators: "[City] Food Studios". Entity display names in the DB still use legacy values — re-skinning to brand is open work.

Operator: **Boris Buono**. Primary language: English (bilingual EN/ES in kitchen).

---

## TECH STACK

| Layer | Technology |
|-------|-----------|
| Frontend | Single HTML file (~12,500 lines, ~760KB), all JS + CSS inline, no build step |
| Hosting | Vercel (static + Edge Functions) |
| Database | Supabase (PostgreSQL) — direct PostgREST calls from frontend |
| AI dispatch | `/api/dispatch.js` — multi-provider router (Anthropic + Google Gemini) |
| Nightly job | `/api/nightly-digest.js` — Gemini 2.5 Pro reads OS state, writes to inbox |
| Accounting | `/api/holded.js` (POS report sync), `/api/missing-invoices.js` (invoice gap detector) |
| Auth | Google OAuth + magic-link (Supabase Auth) |
| PWA | manifest.json + sw.js (network-first HTML, cache-first static, pass-through Supabase + /api/) |
| Fonts | Fraunces (serif), Outfit (sans), DM Mono (mono) via Google Fonts |
| Themes | Bohemian Precision (light), Midnight Pass (dark), White Isle Concierge, Auto |

---

## FILE STRUCTURE

```
/Users/admin/foodstudio/
├── index.html              ← THE entire app (~12,500 lines, all inline)
├── api/
│   ├── ai.js               ← Anthropic proxy (legacy single-shot)
│   ├── dispatch.js         ← Multi-provider router (Anthropic + Gemini), loads agent_skills
│   ├── covers.js           ← Booking system webhook + covers read endpoint
│   ├── holded.js           ← Holded sync (POS report → journal entries)
│   ├── missing-invoices.js ← Holded REST: deliveries without invoices
│   └── nightly-digest.js   ← Vercel Cron → Gemini 2.5 Pro morning brief
├── assets/                 ← Logos, icons (PNG/maskable)
├── manifest.json           ← PWA manifest
├── sw.js                   ← Service worker (network-first HTML, cache-first static)
├── vercel.json             ← Routing + cron schedule
├── supabase-migration.sql  ← Bootstrap schema (subsequent migrations applied via Supabase MCP)
├── CLAUDE.md               ← THIS FILE
├── agents/                 ← Cowork agent prompts (markdown)
│   ├── onboarding-agent.md
│   ├── briefing-agent.md
│   └── recipe-agent.md
└── onboarding/_template/   ← ENTITY_inventory.md, ENTITY_review_flags.md
```

---

## DATABASE SCHEMA (SUPABASE)

Project: `rfdsysrdoncyoytcrzpg`. **56 tables** in public schema. RLS enabled on all. Anon-write policies are open during onboarding/development — tighten before broader rollout.

Tables grouped by domain (snapshot 2026-05-07):

**Identity / entities**: `restaurants`, `entities`, `entity_relationships`, `profiles`, `team_members`, `zones`, `chart_of_accounts`, `inbox_items`, `friction_log`, `audit_log`

**Skills / agents**: `skills` (per-entity Skill bundles), `agent_skills` (16 deployed agent definitions for the dispatcher), `agent_call_log` (per-call latency + provider routing record), `review_flags`

**Recipes / menu / inventory**: `recipes`, `recipe_ingredients`, `recipe_versions`, `menu_items`, `inventory_items`, `lexicon_ingredients`, `lexicon_dishes`, `lexicon_products`, `lexicon_culture`

**Operations / MEP / cleaning**: `tasks`, `task_completions`, `mep_dishes`, `mep_components`, `mep_completions`, `urgent_tasks`

**Suppliers / orders**: `providers`, `provider_products`, `orders`, `order_items`, `supplier_favourites`, `order_dispatch_log`

**Workforce / timekeeping**: `shifts`, `clock_events`

**Reporting / events / bookings**: `eod_reports`, `briefings`, `covers`, `sales_events`, `sales_event_timeline`, `sales_event_lines`, `sales_event_staffing`

**Integrations**: `entity_integrations`, `booking_integrations`, `accounting_integrations`

**HACCP / Spanish APPCC compliance** (Brief 020): `haccp_plans`, `haccp_temperature_logs`, `haccp_pest_control_log`, `haccp_training_log`, `haccp_traceability_log`, `haccp_water_safety_log`, `haccp_maintenance_log`

Migration history is the source of truth for schema evolution — read it via Supabase MCP (`list_migrations`). Briefs 011 (lexicon), 014 (supplier orders), 015 (sales_events), 020 (HACCP), 021 (GPS clock-in fence), 022 (agent_skills + provider routing) are all applied.

Supabase publishable key + URL are in `index.html` (search `SUPABASE_URL`). The key is the anon role — fine to commit; do NOT commit the service role key.

---

## APP ARCHITECTURE

### Global state
All state is in-memory JS globals (no Redux/Zustand):
```javascript
let R = 0               // Active restaurant (0=Taller, 1=Bistro Mondo)
let AREA = 'boh'        // boh / foh / admin
let ZONE = 'Hot Station'
let USER = { name, role, lang, zone }
let currentTab = 'today'
```

### Data constants
Loaded at boot from Supabase, fall back to inline JS constants:
`MENU`, `RECIPES`, `RECIPE_INGREDIENTS`, `RECIPE_STEPS`, `MEP`, `EVENTS`, `SHIFTS`, `WEEK_SHIFTS`, `STAFF`, `PROVIDERS`, `ALLERGENS`, `TASKS`.

These are **declared as top-level `const`/`let` at line ~9300+ of `index.html`**. If they're ever undefined at runtime, that means a brace/syntax bug pushed them into a local scope — see `initApp` defensive guard which now surfaces this directly. (Background: the 2026-05-06 production crash was caused by a missing `}` in `renderEvents` that pulled all data constants and 118 functions into local scope.)

### Tab system
`switchTab(tabName, buttonEl)` → updates `currentTab` → calls `renderTab()` → calls the appropriate `render*()` function → sets `#tab-content` innerHTML.

### Tabs (live)
`today` · `production` · `menu` · `cleaning` · `events` · `schedule` · `skills` · `team` · `command` · `integrations` · `onboard` · `office` · `eod` · `settings`

### AI dispatcher (`/api/dispatch.js`)
- POST body: `{ skill, input, operator_entity_id, user_id }`
- Loads the matching `agent_skills` row (system_prompt, provider, model, schemas)
- Routes to Anthropic Claude Sonnet 4.6 (high-stakes) or Google Gemini 2.0 Flash / 2.5 Pro (volume / long-context)
- Logs to `agent_call_log` (provider, latency, fell_back, request_id)
- Falls back on rate-limit or error

### Nightly digest (`/api/nightly-digest.js`)
Runs daily at 06:00 UTC via Vercel Cron. Pulls a corpus from Supabase (entities, events, inbox, HACCP plans, 24h temp logs, 24h agent calls, 7d friction, 7d orders, yesterday's covers) → calls Gemini 2.5 Pro → writes a structured digest into `inbox_items` as a `nightly_digest` source.

---

## CONVENTIONS

### CSS
- CSS variables in `:root` define the palette. Theme switching swaps the variable values.
- Mobile-first; max-width 480px for nav/content.
- z-index ladder: bottom nav 85, FAB 87, More menu 93, topbar 100, modals 200.

### Editing rules
1. Always Read the file before editing.
2. Search for the exact unique string before replacing.
3. There are duplicate CSS blocks for some mobile nav elements — check both.
4. `renderTab()` calls `render<TabName>()` which return HTML strings set via `innerHTML`.
5. Multi-line template literals contain HTML — be careful when editing them; brace counting is hard. Validate syntax with `node --check` after touching anything > 10 lines in scope.
6. Top-level `const`/`let` declarations live around lines 4400 (USER, ROLE_COLORS, R, AREA, ZONE) and 8000–9500 (data constants). If you see a runtime "X is not defined" for one of these, suspect a missing brace earlier in the file.

### Deploying
```bash
cd /Users/admin/foodstudio
git add -A && git commit -m "..." && git push origin main
```
Vercel auto-deploys on push to `main`. ~30 second deploy time. Watch via Vercel MCP `list_deployments` or the dashboard.

### Testing locally
```bash
python3 -m http.server 3000   # in /Users/admin/foodstudio/
# Then open http://localhost:3000
```

---

## AGENTS

`/agents/` — Cowork agent prompts (markdown):

| Agent | File | Purpose |
|-------|------|---------|
| Onboarding | `agents/onboarding-agent.md` | Ingest venue docs → Skill files |
| Briefing | `agents/briefing-agent.md` | Generate daily pre-service brief |
| Recipe | `agents/recipe-agent.md` | Draft + format recipes |

In-app agent definitions live in Supabase `agent_skills` (16 rows). The dispatcher reads from this table and routes per-skill between providers. To add a new agent: insert a row in `agent_skills` with `system_prompt`, `provider`, `model`, optional `schemas`. No code change needed.

---

## OPERATOR

**Boris Buono** — owner/operator, Ibiza. xr4thf6pyd@privaterelay.appleid.com.
Contact via Cowork session for all decisions. Do not push to production or write to Supabase without confirmation.

---

## CURRENT WORK STREAMS (as of 2026-05-07)

- **Crash fix shipped 2026-05-07**: missing `}` in `renderEvents` was pulling 118 functions + all data constants into local scope. Patched (single brace insert + matching brace removal at end of script block 2). Also added `sb` alias for `db` (six call sites used `sb` directly). `initApp` now surfaces missing-globals diagnostic instead of generic "Something went wrong". See `02_Build/decisions/crash_fix_2026-05-07.md` in the operator project.
- **Holded integration push (in progress)**: bank movements + reconciliation suggestions, supplier contact lookup, cash flow 30/60/90 view. `api/holded.js` + `api/missing-invoices.js` are the seed; `02_Build/code/dispatchers/holded/holded_accounting.py` has the Python CLI reference.
- **Walk-In Fridge Rule architecture (queued)**: IndexedDB write queue, optimistic UI, sw.js cache strategy. Brief filed in `02_Build/decisions/walk_in_fridge_rule.md` (operator project). Q3 2026 work — large refactor, do AFTER Holded is solid.
- **Multi-agent orchestrator pattern (Lindy.ai-style autonomous triggers)**: Q4 2026 work, depends on Walk-In Fridge being shipped.

---

## REFRESH HISTORY

- **2026-05-07**: Full rewrite. Previous version claimed 17 tables and a single `api/ai.js` endpoint — both wildly out of date.
- **2026-05-03**: One-line marker added at end ("cowork direct-push pipeline verified").
- **Pre-2026-05-03**: Original — described the bootstrap schema only.
