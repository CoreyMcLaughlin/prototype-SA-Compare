# Trackman Prototype Template

A starting point for Trackman product prototypes: plain HTML, CSS, and JavaScript, plus Cursor rules and workflow templates so you can focus on the product — not the setup.

---

## What's included

| File / Folder | What it is |
|---|---|
| `index.html` | Entry page — links fonts, CSS, and `js/main.js` |
| `css/`, `js/` | Starter styles and ES modules (including `mockData.js`) |
| `images/` | Public images and icons — Figma exports and anything Cursor creates. Gets deployed |
| `assets/` | Your private folder — DB exports, PDFs, reference screenshots. Never committed, never deployed |
| `CLAUDE.md` | Project context for Claude Code — read automatically when you start a session |
| `.cursor/rules/` | Cursor rules — loaded automatically when you open the project in Cursor |
| `.cursor/templates/` | Workflow templates for PRDs, task lists, and code reviews |

---

## How to start a new prototype

### Step 1 — Copy this template folder

Duplicate this folder and rename it for your prototype. No terminal needed — do it in Finder.

### Step 2 — Open the folder in Cursor

File → Open Folder → select your copy of the template.

### Step 3 — Say this in the Cursor chat

> "I want to make a prototype"

Cursor will follow the workflow in `.cursor/rules/prototype-workflow.mdc`. It will ask what you are building, then whether to build right away or write a PRD and task list first. PRD first still uses a PRD and task list. Build right away goes from a short check-in straight to build.

---

## The full flow

| What you say | What happens |
|---|---|
| "I want to make a prototype" | Cursor runs discovery and follows the template workflow |
| Describe what you're building | Cursor implements it using the static stack and design rules |
| "Add a backend" | Cursor walks you through Supabase setup (see `.cursor/rules/supabase.mdc`) |
| "Deploy this" | Cursor deploys the static site to Vercel and shares a link |

> **First deploy only:** Vercel may open a browser window for a one-time login. After that, deploys can go straight to production.

---

## Key rules to know

- **On-brand look** — orange accent, light grey page background — see `.cursor/rules/design-system.mdc`
- **Mock data** — keep it in `js/mockData.js` (realistic yards, mph, names — no Lorem Ipsum)
- **Assets** — icons and images the prototype shows go in `images/`. `assets/` is yours alone and stays off the deployed link
- **Happy path only** — skip auth, error states, loading states unless you're specifically testing them

---

## Tools

| Tool | How this template helps |
|---|---|
| **Cursor** | `.cursor/rules/` files load automatically and guide all AI output |
| **Claude Code** | `CLAUDE.md` at the root is read automatically at session start |
| **Figma** | Use MCP + designer confirmation for layout and visual fidelity |

---

## Questions?

Check `.cursor/rules/README.md` for a breakdown of what each rule file does.
