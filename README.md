# Onboarding Assistant

A chat assistant for new users and new developers. It answers questions using **only** the system's Use Case Specifications (UCS) and UI Specifications (UIS):

- **How-to questions about screens** get numbered steps plus a short video guide. The video is built from real UIS screenshots, with the relevant element highlighted and a voice-over.
- **Other questions** get a detailed answer with numbered citations that link back to the source documents.
- **Questions the documents don't cover** are refused. The model is never allowed to guess.

| Document | Read it for |
|---|---|
| [docs/STATUS.md](docs/STATUS.md) | **Start here when taking over:** what is done, what has been verified, the remaining development plan, known issues, open questions |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Components, data flows, grounding rules, data model, security, design decisions |
| [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) | Setup, environment variables, tests, how to make common changes, API reference, end-to-end checklist |

## How answers stay grounded

| Stage | Check | If it fails |
|---|---|---|
| Router | Clearly unrelated questions are marked out of scope | Fixed refusal; nothing is searched |
| Scope gate | The best search result must reach a minimum relevance (Settings) | Fixed refusal; the answer model is never called |
| Answer | Claude only receives the retrieved sections, with citations enabled | n/a |
| Citations | Every sentence must cite a source; text without a citation is dropped unless it is formatting | Sentence removed |
| Quote check | Each cited quote must appear verbatim in the stored section (code, not AI) | Claim removed |
| Verifier | A second model checks each claim against its quotes | Claim removed |
| Threshold | If too much was removed, the whole answer is refused | Fixed refusal |
| Video | Scenes must use real screenshots and real element labels; narration is verified against the cited steps, or replaced with the step itself | Scene fixed or dropped |

The answer text is sent to the browser only after all checks pass.

## Layout

| Path | What it is |
|---|---|
| `packages/shared` | Types, Zod schemas, settings defaults, environment config |
| `packages/db` | Drizzle schema and SQL migrations (Postgres with pgvector) |
| `packages/ingestion` | OneDrive and local-folder connectors, .docx/.pdf parsing, chunking, embeddings, indexer |
| `packages/agents` | Hybrid retrieval and reranking, Claude calls (router, answer, verifier, vision, storyboard), grounding, chat pipeline, tracing and cost |
| `packages/video` | Frame drawing (sharp), text-to-speech (Azure, or silent captions), MP4 assembly (FFmpeg) |
| `apps/worker` | BullMQ worker: crawl jobs on schedules, screenshot descriptions, video rendering |
| `apps/api` | Fastify API: chat over server-sent events, conversations, videos, and the admin API, all behind Entra ID roles |
| `apps/web` | React app: chat for users; admin pages for sources, crawl jobs, documents, screens, sessions, usage, videos, insights, playground, settings and audit |
| `test/` | Test helpers: in-process Postgres (PGlite), fake connector, fake Claude, .docx fixtures |
| `scripts/` | `check-credentials.ts`, `inspect-doc.ts`, `make-sample-docs.ts` |

## Prerequisites

- Node.js 20 or later (developed on 24)
- Docker, for Postgres and Redis
- An Anthropic API key (console.anthropic.com)
- A Voyage AI API key (embeddings and reranking)
- An Entra ID app registration (see below)
- Optional: an Azure AI Speech resource for voice-over

## Entra ID setup

1. Register an app, for example **Onboarding Assistant**.
2. **Expose an API:**
   - Click **Add** next to Application ID URI and accept the default `api://<client-id>`. Most tenants reject custom URIs unless they use a verified domain.
   - Add a scope named `access_as_user`.
   - Set `API_AUDIENCE` in `.env` to the Application ID URI.
3. **Authentication:**
   - Add a **Single-page application** platform with the redirect URI `http://localhost:5173`, plus your production URL later.
   - Under **API permissions**, add your own `access_as_user` scope and grant consent.
4. **App roles:**
   - Create `Assistant.Admin`, `Assistant.ContentReviewer`, `Assistant.Developer` and `Assistant.User`.
   - Assign users or groups to them under Enterprise Applications.
   - Developers get developer-style answers by default.
5. **Reading SharePoint (company tenant only):**
   - Add the Microsoft Graph *application* permission `Sites.Selected` (or `Files.Read.All`).
   - Grant admin consent.
   - Create a client secret.
   - This needs a Microsoft 365 tenant. A personal Azure tenant has no SharePoint; use a Local folder source there.

To verify the credentials without printing them, run `npx tsx --env-file=.env scripts/check-credentials.ts`.

## Run locally

```bash
cp .env.example .env            # then fill in the values
docker compose -f infra/docker-compose.yml up -d
npm install
npm run db:migrate
npm run dev:worker              # crawls, screenshot descriptions, video rendering
npm run dev:api                 # http://localhost:4000
npm run dev:web                 # http://localhost:5173  (open this)
```

- **Testing without Entra sign-in:** set `AUTH_DEV_ROLES=Assistant.Admin` in `.env`. Every request is then treated as a local admin. The API refuses to start with this set when `NODE_ENV=production`.
- **Local folder sources:** list the allowed folders in `LOCAL_SOURCE_ROOTS`, separated by `;`, then add the source from **Admin → Sources**.
- **Voice-over:** set `AZURE_SPEECH_KEY` and `AZURE_SPEECH_REGION`. Without them, videos still render, using on-screen captions.

## Tests

```bash
npm test           # no Docker or API keys needed: PGlite + fake Claude + real FFmpeg
npm run typecheck
```

## Keeping the knowledge base in sync

- **Every 30 minutes (per source, configurable):** a delta sync fetches only what changed since the last successful run.
- **Nightly:** a full reconciliation removes documents that disappeared without a delta record.
- **On demand:** admins can run **Sync now** or **Full reindex**.
- **After every crawl:** new or replaced screenshots are described by Claude vision. The description lists visible elements with boxes, which admins can correct on the Screens page.

What happens to each change:

| Change | Result |
|---|---|
| New file | Indexed |
| Edited file | Only changed sections are re-embedded; unchanged screenshots keep their descriptions; the new version goes live in one transaction; videos built from it are marked stale |
| Rename or move inside the folder | Re-read, but embeddings are reused |
| Delete, or move out of the folder | Removed from search; the row is kept for audit |
| Parser improved (`PARSER_VERSION`) | Older documents are re-read automatically, 50 per run |

## Observability and cost

Every question is stored as a trace. **Admin → Sessions** shows its timeline:

- the router decision
- the retrieved sections with relevance scores
- the scope gate
- citations and removed claims
- the final outcome

It also shows every model and API call with input, output and cache tokens, latency and cost. **Usage** totals cost per day, step, model and user.

Budgets (daily, monthly, per user) are enforced before any model call. Admins see a banner at 80% and 100%. Prices are editable under **Settings**.
