# Food Studio OS — Project Context

> Read this file before taking any action in this project.
> This is the master context document for all CoWork agents and sessions.

---

## WHAT THIS IS

**Food Studio OS** is a kitchen operating system for restaurant groups.
It runs as a single-page web app (one HTML file) deployed on Vercel,
backed by Supabase for persistence.

Current live URL: **https://food-studio-os.vercel.app**
Local preview: `npx serve /Users/admin/foodstudio -p 3000`

---

## ENTITIES IN THE SYSTEM

| Slug | Name | Type | Index |
|------|------|------|-------|
| `taller` | Taller | Restaurant, Ibiza | R=0 |
| `bistro-mondo` | Bistro Mondo | Restaurant, Ibiza | R=1 |

Both are part of **Boris Buono Holdings**, operated by Boris Buono.
Primary language: English (bilingual EN/ES in kitchen).

---

## TECH STACK

| Layer | Technology |
|-------|-----------|
| Frontend | Single HTML file — all JS + CSS inline, no build step |
| Hosting | Vercel (static) |
| Database | Supabase (PostgreSQL + JS v2 CDN) |
| AI proxy | Vercel Edge Function `/api/ai.js` → Anthropic Claude |
| Fonts | Fraunces (serif), Outfit (sans), DM Mono (mono) via Google Fonts |
| Preview | `npx serve` on port 3000 |

---

## FILE STRUCTURE

```
/Users/admin/foodstudio/
├── index.html              ← THE entire app (3,400+ lines, all inline)
├── api/
│   └── ai.js               ← Vercel Edge Function: Anthropic proxy
├── vercel.json             ← Routing: /api/* → edge, everything else → index.html
├── supabase-migration.sql  ← Full schema (run once in Supabase SQL editor)
├── CLAUDE.md               ← THIS FILE
├── agents/                 ← CoWork agent prompts
│   ├── onboarding-agent.md
│   ├── briefing-agent.md
│   └── recipe-agent.md
├── skills/                 ← Reusable skill definitions
│   ├── taller_skill_brandbook.md
│   ├── taller_skill_kitchen.md
│   └── bistro-mondo_skill_brandbook.md
└── onboarding/             ← Onboarding output per venue
    ├── _template/
    ├── taller/
    └── bistro-mondo/
```

---

## DATABASE SCHEMA (SUPABASE)

All tables use `uuid` PKs and `restaurant_id` FK to scope data per venue.
RLS is enabled with open anon policies (to be tightened in production).

| Table | Purpose |
|-------|---------|
| `restaurants` | Entity registry (Taller, Bistro Mondo) |
| `events` | Private dining / group events |
| `event_menu_items` | Line items per event |
| `recipes` | Recipe catalogue |
| `recipe_ingredients` | Ingredients per recipe |
| `recipe_steps` | Step-by-step instructions per recipe |
| `recipe_versions` | Version history per recipe |
| `menu_items` | Active menu dishes per restaurant |
| `providers` | Supplier catalogue |
| `provider_products` | Products per supplier |
| `staff` | Staff registry |
| `shifts` | Daily shift assignments |
| `shift_schedule` | Recurring weekly schedule template |
| `tasks` | Opening/closing checklist tasks |
| `mep_items` | MEP (mise en place) dishes per zone |
| `mep_components` | Components per MEP dish |
| `eod_reports` | End-of-day reports |
| `urgent_tasks` | Real-time urgent task pushes |

Supabase credentials are in `index.html` (lines 1401–1403).
Do NOT commit credentials to public repos.

---

## APP ARCHITECTURE

### Global State
All state is in-memory JS globals (no Redux/Zustand):
```javascript
let R = 0               // Active restaurant (0=Taller, 1=Bistro Mondo)
let AREA = 'boh'        // boh / foh / admin
let ZONE = 'Hot Station'
let USER = { name, role, lang, zone }
let currentTab = 'today'
let todayPhase = null   // null=auto, 'opening'/'service'/'closing'
let activeWorkflows = [] // [{recipeId, recipeName, stepIdx, steps, startedAt}]
```

### Data Constants (loaded at boot from Supabase, fall back to inline defaults)
`MENU`, `RECIPES`, `RECIPE_INGREDIENTS`, `RECIPE_STEPS`, `MEP`, `EVENTS`,
`SHIFTS`, `STAFF`, `PROVIDERS`, `ALLERGENS`, `TASKS`

### Tab System
`switchTab(tabName, buttonEl)` → updates `currentTab` → calls `renderTab()`
→ calls the appropriate `render*()` function → sets `#tab-content` innerHTML.

### Tabs
`today` | `menu` | `mep` | `ordering` | `recipes` | `briefing` |
`cleaning` | `events` | `schedule` | `cookmode`

### AI
- **AI Overlay** (`openAI()`) — full-screen modal with voice + text
- **AI Bar** — floating pill above bottom nav (text input + mic)
- **Quick prompts** in overlay: Draft recipe, Quantities, Supplier order,
  Menu margins, Pre-service brief, Urgent tasks
- All AI calls → `/api/ai.js` → Anthropic claude-sonnet-4-6

---

## KNOWN PATTERNS & CONVENTIONS

### CSS
- CSS variables in `:root`: `--ember` (#B86A42), `--fern` (#5A8A78),
  `--gold` (#B8963A), `--ruby` (#A03838), `--text-primary` (#1A1510)
- Mobile-first, max-width 480px for nav/content
- Desktop: sidebar nav (hidden on mobile with `display:none !important`)
- Fixed bottom nav: z-index 85 | FAB: 87 | More menu: 93 | Topbar: 100 | Modals: 200

### Editing rules
1. Always read the file before editing
2. Search for the exact string before replacing
3. There are duplicate CSS blocks for some mobile nav elements — update BOTH
4. `renderToday()`, `renderMenu()`, etc. return HTML strings set via `innerHTML`
5. Never use `document.getElementById('app').style.display` — use `.classList`

### Deploying
```bash
git add index.html && git commit -m "..." && git push origin main
```
Vercel auto-deploys on push to `main`. ~30 second deploy time.

### Testing locally
```bash
npx serve /Users/admin/foodstudio -p 3000
# Then open http://localhost:3000
```
Use `preview_*` MCP tools for browser automation testing.

---

## AGENTS IN THIS PROJECT

See `/agents/` directory. Each agent has its own prompt file with:
- Role definition
- Config block (fill per session)
- Stage-by-stage instructions
- Constraints

| Agent | File | Purpose |
|-------|------|---------|
| Onboarding | `agents/onboarding-agent.md` | Ingest venue docs → Skill files |
| Briefing | `agents/briefing-agent.md` | Generate daily pre-service brief |
| Recipe | `agents/recipe-agent.md` | Draft + format recipes |

---

## OPERATOR

**Boris Buono** — owner/operator, Ibiza
Contact via this Claude session for all decisions.
Do not push to production or write to Supabase without confirmation.

---

## PENDING WORK (as of last session)

- [ ] Today page redesign: compact header + phase tabs + active workflows
- [ ] AI bar: floating pill, remove chips (CSS done, renderToday rewrite pending)
- [ ] Siri-style voice: persistent voice mode on Today tab
- [ ] Onboarding: fill CONFIG and run Stage 1 for Taller
- [ ] Supabase: migrate to production (currently using anon open policies)

<!-- 2026-05-03: cowork direct-push pipeline verified -->
