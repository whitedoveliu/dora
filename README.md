<div align="center">

# Dora.ai

**The open-source version of Instinct.**

English · [简体中文](README.zh-CN.md)

<a href="#-quick-start"><img src="https://img.shields.io/badge/Quick_Start-3_steps-blue?style=for-the-badge" alt="Quick start"></a>
<a href="#-reference"><img src="https://img.shields.io/badge/Tool_surface-214_actions_%2F_40_families-green?style=for-the-badge" alt="Tool surface"></a>
<a href="#-verification"><img src="https://img.shields.io/badge/Tests-59_passing-brightgreen?style=for-the-badge" alt="Tests"></a>
<a href="#-architecture"><img src="https://img.shields.io/badge/Sandbox-seatbelt_%28local%29-red?style=for-the-badge" alt="Sandbox"></a>
<a href="#-status"><img src="https://img.shields.io/badge/Status-private_preview-lightgrey?style=for-the-badge" alt="Status"></a>
<img src="https://img.shields.io/badge/Node-%E2%89%A522.6-339933?logo=node.js&logoColor=white" alt="Node ≥ 22.6">

</div>

## 📌 What this is

Dora answers one question: what does it take to run a personal agent for real — one that holds a member's
memory, speaks on their channels, and acts only through tools you can fence in?

It is the open-source implementation of the architecture documented for **Instinct**: the same mechanisms,
rebuilt from scratch in TypeScript on Node's standard library, and moved off the cloud onto your own machine.

```text
wake (message · schedule · subscription · task report)
  → memory_recall injection          memory excerpts, newest last_modified first
  → system prompt                    role · action space · tool index · 27 sections
  → model turn, exactly two tools    bash | hold
  → bash runs `tools …` in a fence   permission matrix → connector status → help gate
  → tool_result event                stdout / stderr / attachments stored in full
  → hold
```

## ✨ Key features

| | |
|---|---|
| 🧠 **Two roles, one capability matrix** | main / task agents × 15 traits × 4 modes — denied calls return `ACCESS delegated` / `ACCESS unavailable` (exit 4) |
| 🔒 **A kernel fence, not a prompt rule** | macOS seatbelt: `/memory` is read-only, the vault and the database are unreadable, one workspace per session; on a host without `sandbox-exec` bash refuses to run at all |
| 🧰 **Exactly two base tools** | `bash` and `hold`. Everything else is a `tools` CLI call, and a contract must be read before the first call (help gate, exit 3) |
| ⏰ **Four wake sources, one queue** | user message · cadence/clock/cron schedule · event subscription · task report — plus trigger evaluation and subscription safety check-ins |
| 🗜️ **8-section compaction** | over budget, a run collapses into a fixed 8-section summary that never drops the system prompt |
| 🧩 **Three-layer skills** | 24 skills: `description` → `SKILL.md` → `references`, role-gated by frontmatter and compiled per account through `{{flag:…}}` |
| 🗃️ **Three data planes, three rules** | `/memory` read-only git markdown · observations read-only SQL index · vault AES-256-GCM and fill-only (no API returns a secret) |
| 📊 **Verifiable by running it** | 59 `node:test` cases, `dora demo` walks 23 mechanisms with PASS/FAIL, 16 bench tasks scored on the event stream |

## 🤔 How it differs from Instinct

| Dimension | Instinct (as documented) | Dora |
|---|---|---|
| Execution | E2B / Firecracker micro-VM (`e2b.local`, user `sandbox`) | the host's own kernel via macOS `sandbox-exec`; `RemoteSandboxAdapter` is a declared stub |
| Integrations | vendor OAuth (Google, Microsoft, Slack, Notion…) | local accounts: fixture datasets or a pasted token — no OAuth flow exists |
| Browser | rented cloud browser instances | local HTTP driver + lease scheduler; screenshots are text renderings |
| Tool surface | a catalogue of 576 actions | 214 actions routed across 40 families; the catalogue still declares 579 |
| Model | undisclosed | anything OpenAI-compatible; `mock` (deterministic, offline) by default |
| Voice | realtime voice sessions | `speak` / `steer_voice_agent` raise `UNAVAILABLE` |
| Delivery | WhatsApp / SMS / iMessage first | channels are local: sends land in SQLite, inbound arrives via `POST /api/channels/inbound` |
| Data | hosted control plane | one SQLite file, one git repo and one encrypted blob, all under `DORA_DATA_DIR` |

## 🧩 What you build yourself to get Instinct's effects

Nothing below is hidden behind a paywall — it is the part that needs a real account, a phone number or a cloud.

| Effect you want | What Dora ships today | What you add |
|---|---|---|
| A number that answers on WhatsApp / SMS | local channel store, no gateway | Twilio or Meta Cloud API (WhatsApp 24-hour window is already enforced); inbound posts to the local webhook |
| Your real Gmail / Calendar / Drive | 28 connector descriptors backed by 44 fixture records | register an OAuth app and implement the per-connector client behind `connectors.records/put` |
| A cloud sandbox | local seatbelt | implement `RemoteSandboxAdapter.exec` for E2B, Firecracker, gVisor or your own VM |
| A real browser | local driver, text-render screenshots | point the driver at Playwright or a hosted browser service |
| Search that scales | keyless DuckDuckGo HTML endpoint (works out of the box) | set `DORA_SEARCH_ENDPOINT` to a paid API |
| Payments, flights, weather, maps, images | contract and guard, no provider | plug in one provider per family; today they answer `no … provider configured` |
| Voice in and out | declared unavailable | a realtime voice session |
| The 365 declared-but-unrouted actions | the help index knows the names; calls return `unknown action` (exit 64) | implement them against their contracts |

## 🚀 Quick start

Prerequisites: **Node ≥ 22.6** (native TypeScript, `node:sqlite`), **git**, and macOS for the seatbelt fence.

```bash
# 1 — link the workspace, then build the tools CLI that runs inside the sandbox
pnpm install && pnpm build:cli

# 2 — create the data dir, seed the account, print the admin token
node bin/dora.ts init

# 3 — walk every mechanism (PASS/FAIL), then start the runtime
node bin/dora.ts demo
node bin/dora.ts serve        # console + control API on http://127.0.0.1:8420
```

Optional — a live model (the default `mock` provider is deterministic and offline):

```bash
export DORA_MODEL_PROVIDER=openai DORA_API_KEY=sk-… DORA_BASE_URL=https://api.deepseek.com/v1
node bin/dora.ts chat         # the same runtime, in your terminal
```

## 🏗️ Architecture

```text
bin/dora.ts            init · serve · chat · demo · tools · bench · logs · doctor
apps/api               HTTP + SSE control plane, admin console, vault fill page
apps/web               management SPA, and /agent behind the agent_chat flag
packages/core          types, events, capability matrix, prompt, compaction, recall, flags
packages/sandbox       seatbelt profile, workspace layout, bash runner, output budget
packages/tools         tools CLI, help pages, help gate, 40 families
packages/runtime       agent loop, wakes, subscriptions, delegation, session socket
packages/{memory,observations,vault}   the three data planes
packages/{integrations,providers,skills}
```

Boundary rules: the model never sees a tool contract until the gate serves it; every tool call is a process
inside the fence; the main agent delegates — a task agent drives the browser and may never write to a channel.

## 📊 Reference

Commands — all run from the repository root:

| Command | What it does |
|---|---|
| `node bin/dora.ts init` | prepare `DORA_DATA_DIR`, seed account data, print the admin token |
| `node bin/dora.ts demo` | walk 23 mechanisms with PASS/FAIL, offline and deterministic |
| `node bin/dora.ts serve` | runtime + control API + console (`--port`, default 8420) |
| `node bin/dora.ts chat` | talk to the main session in the terminal |
| `node bin/dora.ts tools …` | the tools CLI, exactly as the agent sees it |
| `node bin/dora.ts doctor` | environment and isolation probes |
| `node bin/dora.ts bench` | 16 tasks against the live model (only this spends money) |
| `node bin/dora.ts logs` | structured server log (`--level`, `--channel`, `--session`) |

Environment:

| Variable | Default | Meaning |
|---|---|---|
| `DORA_DATA_DIR` | `~/.dora` | database, workspaces, memory repo, vault, logs |
| `DORA_MODEL_PROVIDER` | auto (`mock` if no credential is found) | `mock` or `openai` |
| `DORA_API_KEY` / `DORA_BASE_URL` | — / DeepSeek | any OpenAI-compatible endpoint |
| `DORA_MODEL_MAIN` / `_FAST` / `_SMART` | `deepseek-v4-pro` / `-flash` / `-pro` | per-tier model ids |
| `DORA_ALLOW_UNSANDBOXED` | unset | `1` runs bash without a fence on a host that has none |
| `DORA_SEARCH_ENDPOINT` | DuckDuckGo lite | search backend for `search.search` / `web_fetch.fetch` |
| `DORA_LOG_LEVEL` | `info` | `debug` · `info` · `warn` · `error` |

Data plane: `/memory` is a git repository the agent may read but never write · observations accepts
`SELECT`/`WITH` only, 3 s and 10 000 rows · the vault encrypts AES-256-GCM and can fill a form, never read back.

## ✅ Verification

```bash
pnpm test                    # 59 node:test cases, offline, ~9 s
node bin/dora.ts demo        # 23 mechanisms
node bin/dora.ts doctor      # node · sqlite · seatbelt · git · fences · model · skills · tools
```

Two failures are environmental, not regressions: without `/usr/bin/sandbox-exec` bash refuses to run (that is
the fence working), and a live `bench` run needs a model credential — tests and `demo` never do.

## 📄 Status

Private preview. No license is granted yet; the repository is not public and no code may be reused until one is.

Architecture notes, the mechanism table and the operations guide live in [`docs/`](docs/).
