# Trackman Prototype Template

This is a starting point for Trackman product prototypes. Read this file before generating any code.

---

## What this is

A prototype template for Trackman product designers. The goal is always something testable, built fast — either with real users or as a concept for the product team. Optimise for speed over production hardening (error handling, accessibility passes, performance tuning, edge-case coverage) — but layout, typography, spacing and colour should still match the agreed Figma frames unless the PRD says otherwise.

---

## Starting a new prototype

When the user says anything like "I want to make a prototype", "start a prototype", or "set up a prototype":

**Follow `.cursor/rules/prototype-workflow.mdc` exactly.** Kickoff always asks **build the prototype right away** or **write a PRD and task list first**. Then:

1. **Discovery** — kickoff questions in one message (what, who, Figma, out of scope, then path). Mock data unless they ask for real data. Do not ask them to name the prototype.
2. **Figma + build check-in** — if a link was provided, inspect it. Always write three sentences on what you will build and wait for confirmation. If there is no Figma, still do the three sentences.
3. **PRD** — **user testing only:** write the PRD using `.cursor/templates/1. create-prd.md`, get explicit designer approval. **Concept:** skip. No PRD file.
4. **Task list** — **user testing only:** generate it using `.cursor/templates/2. generate-tasks.md`, get explicit designer approval. **Concept:** plan tasks privately; do not save or present a task file.
5. **Setup** — static HTML/CSS/JS, fonts, mock data, local static server. User testing: after task list approval. Concept: after the three-sentence yes.
6. **Build** — **user testing:** one task at a time using `.cursor/templates/3. process-task-list.md`, check in after each parent task. **Concept:** build through without per-task stops; stop only if something is unclear.
7. **Wrap-up** — offer to deploy to Vercel, continue tweaking, or write the product handoff doc (deploy via `.cursor/rules/deploy.mdc` — password gate required before `npx vercel`; handoff via `.cursor/rules/handoff.mdc`)

**Do not run any commands or write any code until Step 1 is answered and the three-sentence build check-in is confirmed.** On the user-testing path, also wait for PRD and task list approval before setup and build.

---

## Stack

| Decision | Chosen |
|---|---|
| Markup | HTML5 |
| Styling | CSS (plain — files under `css/`) |
| Behaviour | JavaScript (ES modules — files under `js/`) |
| Database | None by default — mock data only |
| Deployment | Vercel (static site) |

**Key conventions**

- Entry HTML: `index.html` at project root
- Styles: `css/*.css` — use variables in `:root` for brand-aligned colours (see `.cursor/rules/design-system.mdc`)
- Scripts: `js/*.js` — `type="module"` for imports between files
- Mock data: `js/mockData.js` (or split into `js/data/*.js` if it grows)
- Images and icons: `images/` at project root — everything you export from Figma or create yourself goes here
- No React, no Tailwind, no build step required for the default flow

**Assets — where files go**

| Folder | Who puts things there | Deploys? |
|---|---|---|
| `images/` | You — icons exported from Figma, logos, illustrations, screenshots used in the UI | Yes |
| `assets/` | The designer only — private local files (DB exports, PDFs, reference screenshots) | No |

- Put every asset you export or create in `images/` (subfolders like `images/icons/` are fine). Reference it as `images/icons/close.svg`.
- **Never** write to `assets/`. It is git-ignored and excluded from deploys, so anything you put there is missing on the live link.
- **Never** create a root-level `public/` folder. Vercel treats a root `public/` as the whole site and the prototype breaks.
- Only read from `assets/` when the designer points you at a file in there. If they want it in the UI, copy it into `images/` first.

---

## Design System — Trackman (TDS4)

High-level guidance lives in `.cursor/rules/design-system.mdc`. This template does **not** include a full `design-tokens.all.css` file — stay on-brand using Figma, designer input, and sensible semantic CSS variables (orange accent, off-white page background, etc.).

### Fonts

| Role | Font | Used for |
|---|---|---|
| Body & labels | Inter | UI copy, labels |
| Display | Oswald | Large scores, stats, display headings |

Load via Google Fonts in `index.html` (see the starter file). Do not rely on system defaults alone for final polish.

### Visual rules

- Brand colour is orange (`#ec691a`) — not blue as the primary accent
- Page background should feel like Trackman product chrome (typically light grey `#f6f6f6`), not stark white full-bleed unless the frame says so
- For data visualisation: positive = green, negative = red, neutral = yellow — when showing charts or deltas

### Mapping Figma to CSS

- Translate Figma spacing and type to consistent steps in your CSS — round to a simple scale (e.g. 4px or 8px base) and align with designer expectations
- If a colour in Figma does not match an agreed brand value, ask the designer rather than guessing

---

## Prototype Scope

### What to build

- The happy path only
- Realistic mock data (no "Lorem Ipsum", no "User 1, User 2")
- Enough visual fidelity to feel like a real Trackman product
- Interactions that are relevant to what's being tested

### What to skip

- Authentication — use a hardcoded mock user
- Error states — unless the error handling IS what's being tested
- Loading states — unless the loading experience IS what's being tested
- Form validation — keep it minimal
- Unit tests — not needed
- Performance optimisation — not needed
- Responsive design — build the breakpoints listed in the PRD. If Figma includes mobile/tablet frames and the PRD has them in scope, they must be built. Default to desktop only when the PRD does not specify.
- Animations — build motion that is specced in the Figma frames in scope, or that IS what's being tested. Skip decorative motion not in the PRD.

### The one question to ask before building anything

> User testing: "Does this help test the idea with a user, or am I just over-engineering?"
> Concept: "Does this help show the idea to the product team, or am I just over-engineering?"

If it doesn't help — skip it.

### Complexity check

If you're about to suggest any of the following unprompted — stop and ask whether it's needed:

- Setting up authentication or user sessions
- Heavy frameworks (React, Vue, Svelte) unless the user asks
- API integrations beyond what's being tested
- Database setup
- Abstracting components into a shared library

---

## Mock Data

- Keep mock data in `js/mockData.js` (or imported modules)
- Use realistic Trackman values: distances in yards, speeds in mph, real-sounding player names
- Make it realistic — a designer showing this to a PO or user should not have to say "ignore the dummy data"

---

## Project Structure

```
my-prototype/
  index.html          ← entry point
  css/
    styles.css        ← global styles, CSS variables
  js/
    main.js           ← bootstraps the UI
    mockData.js       ← mock data
  images/             ← public images and icons (Figma exports, logos) — deploys
    icons/
  assets/             ← designer's private local files — never deploys, never write here
```

Do not add a root-level `public/` folder — Vercel would serve it as the whole site.

---

## Deployment

**Follow `.cursor/rules/deploy.mdc` exactly.** That rule is always applied.

When the user says deploy / publish / share / go live:

```
STOP — do not run npx vercel yet.
```

**Required order (no skipping):**

1. Confirm `index.html` at project root (no `npm run build` for the default stack)
2. Run: `test -f middleware.js && test -f vercel.json && echo "protection files OK" || echo "MISSING protection files — stop"`
3. If missing: create `middleware.js` and `vercel.json` from the snippets in `.cursor/rules/deploy.mdc` (`vercel.json` is `{}` — do not configure middleware under `functions` / `runtime`)
4. Ensure `package.json` includes `@vercel/edge` (create/merge from `.cursor/rules/deploy.mdc`)
5. If `PROTO_PASSWORD` is not set: ask the designer for a password, then run `vercel env add PROTO_PASSWORD` (**before** deploy)
6. Only now deploy: `.vercel` exists → `npx vercel --prod`; else → `npx vercel` (link project)
7. Share **`https://[url]?pw=[password]`** — never a bare production URL

Skipping steps 2–5 is a failure. Full snippets and anti-patterns live in `.cursor/rules/deploy.mdc`.

---

## Handoff documentation

A product-first document so product can review the prototype and write user stories from what exists now. Not a second PRD.

When the user says "create the handoff documentation", "update the handoff documentation", or picks "handoff" at wrap-up:

1. Follow `.cursor/rules/handoff.mdc` and `.cursor/templates/5. create-handoff.md`
2. Read the prototype and prior chat first; use the PRD and task list as light backup, not the main source
3. Fill everything you can from the build before asking the user anything
4. Give reviewer links up top (deployed `?pw=` link, Figma, PRD, task list) and use unchecked task list items to show what is left
5. Save to `.cursor/documents/handoffs/handoff-[prd-file-name].md`; update in place if it already exists. If there is no PRD, use a kebab-case slug from what was built.

Covers: learning goal, how we will know it worked, what's built, main user stories, prototype vs product, user paths, edge cases, in / out of scope, open questions and assumptions. Write it in plain, non-technical language with edge cases framed as user situations. Available on demand after a prototype exists, including the concept path with no PRD.

---

## Supabase (optional backend)

Only set up Supabase when the user explicitly asks for a backend, real data, or persistence. Mock data is the default.

If requested, follow `.cursor/rules/supabase.mdc`.

---

## Product Context

> **Replace this section with context specific to what you're building.**

Add here:

- What the product does and who it's for
- Key user types and their goals
- Terminology specific to this product area
- Any known constraints or design decisions already made

Without this, output will be generic. The more context, the better the output.

---

## Tone of Voice

- Act as a senior full-stack developer and senior product designer
- Assume the reader is a product designer — not a developer
- TLDR only. Lead with the point. No preamble, no recap, no filler
- Keep it designer-friendly and AI-slop free. Do not use words like leverage, robust, seamless, streamline, or elevate
- Be short and to the point — no long explanations unless asked
- When something needs a decision, present options clearly rather than assuming
- Ask before assuming on anything product or data related

---

## Definition of Done for a Prototype

- A user can click through the relevant flow
- It looks like a Trackman product
- It uses realistic data
- It can be deployed to Vercel and shared via a password-protected link (`?pw=`)
