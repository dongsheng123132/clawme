# CLAUDE.md — ClawMe Project Guide

## What is ClawMe?

ClawMe is a bridge between AI Agents and users' devices. Agents send structured instructions → ClawMe delivers them to browser/phone → user confirms and executes (or auto-executes). A butler, not a boss.

## Project Structure

```
backend/          Node.js + Express + TypeScript backend (port 31871)
extension/        Chrome MV3 extension (side panel, service worker, 7 instruction types)
web/              clawme.net static site + PWA mobile app (deployed to Vercel)
openclaw-clawme/  OpenClaw plugin (registers clawme_send tool)
deploy/           VPS deployment scripts (PM2 + Cloudflare Tunnel)
docs/             Protocol spec, architecture, guides
store/            Chrome Web Store assets and listing content
```

## Key Technical Details

### Backend (`backend/`)
- Express server, TypeScript, in-memory store (no database)
- Auth: `X-ClawMe-Token` header or `Authorization: Bearer <token>`
- Endpoints: `POST /v1/instructions`, `GET /v1/instructions/pending?target=browser`, `POST /v1/instructions/:id/result`, `POST /v1/messages`
- Tokens configured via `CLAWME_TOKENS` env var (comma-separated) or defaults to `"test"`
- Relays results to OpenClaw via `OPENCLAW_CALLBACK_URL`
- Build: `npm run build` (tsc), Run: `npm start`

### Chrome Extension (`extension/`)
- **Manifest V3** with side panel UI (not popup)
- Permissions: `storage`, `scripting`, `sidePanel`, `alarms`, `notifications`, `tabs`, `activeTab`
- Host permissions are `optional_host_permissions` (requested on demand, not upfront)
- Background service worker polls backend every 30s via `chrome.alarms`
- 7 instruction types: `remind`, `open_url`, `compose_tweet`, `compose_email`, `fill_form`, `click`, `extract`
- Workflow support: instructions grouped by `meta.workflow_id`, executed sequentially
- All UI text is in Chinese (zh-CN)

### Extension File Layout
```
extension/
  manifest.json
  background/service-worker.js    Entry: alarm polling, notifications, message routing
  background/poller.js            Poll logic, badge updates, new instruction detection
  background/notifications.js     Desktop notification display
  sidepanel/sidepanel.{html,css,js}  Main UI (settings, instruction cards, execution log)
  lib/api.js                      Backend API calls (fetchPending, reportResult)
  lib/executor.js                 Instruction type → handler dispatcher
  lib/workflow.js                 Multi-step workflow runner
  lib/constants.js                Type labels, colors, defaults
  lib/utils.js                    waitForTabLoad, ensureHostPermission, navigateAndWait
  lib/instructions/               One file per instruction type handler
```

### Website + PWA (`web/`)
- Static HTML/CSS/JS, deployed to Vercel (root directory = `web/`)
- Domain: `clawme.net` (Cloudflare DNS)
- PWA with `manifest.json`, installable on mobile
- Privacy policy at `privacy.html`

### Deployment
- Backend on Tencent Cloud VPS (101.32.254.221), managed by PM2
- External access via Cloudflare Named Tunnel (`api.clawme.net` → localhost:31871)
- Tunnel ID: `d1c8a2a9-a0cf-4f1e-b0f6-867c8d42912b`
- Website on Vercel (`clawme.net`, `www.clawme.net`)

## Development Commands

```bash
# Backend
cd backend && npm install && npm run build && npm start

# Load extension in Chrome
# chrome://extensions → Developer mode → Load unpacked → select extension/

# Test instruction
curl -X POST http://127.0.0.1:31871/v1/instructions \
  -H "Content-Type: application/json" -H "X-ClawMe-Token: test" \
  -d '{"target":"browser","instruction":{"type":"remind","payload":{"title":"Test","body":"Works!"}}}'

# Deploy backend to VPS
ssh root@101.32.254.221 'bash -s' < deploy/setup.sh
```

## Conventions

- Extension UI strings are in Chinese
- License: AGPL-3.0
- No database — backend stores instructions in memory only
- All data flows: Agent → Backend → Extension/PWA; never through third-party services
- fill_form supports: standard inputs, contenteditable (rich text editors), React/Vue framework inputs, select/checkbox/radio
- CSS selectors used for element targeting in fill_form, click, extract instructions

## Known Constraints

- `chrome.alarms` minimum interval is 30 seconds in production
- `chrome.scripting.executeScript` fails on restricted pages (`chrome://`, Chrome Web Store)
- Service worker can't call `chrome.permissions.request()` — only works from extension pages
- `document.execCommand("insertText")` used for contenteditable (deprecated but still works in Chrome)
