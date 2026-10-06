# Project status and development plan

*Status as of 6 October 2026.* This is the handover for the developers continuing the project. It covers what is finished, how each part was checked, and what remains, in priority order.

Before starting, read **section 3 (verification gaps)**. Several parts are complete in code but have **never run against the real external service**.

## 1. Summary

| Area | Built | Verified with real services | Verified by automated tests |
|---|---|---|---|
| Crawl job, local folder | ✅ | ✅ Postgres, Redis, Voyage | ✅ |
| Crawl job, OneDrive / SharePoint | ✅ | ❌ No M365 tenant available yet | ✅ mocked Graph |
| Parsing and classification (.docx) | ✅ | ✅ Two sample IRAS specs | ✅ |
| Hybrid retrieval and rerank | ✅ | ⚠️ Voyage works; relevance threshold not tuned | ✅ fake reranker |
| Router, answer, verifier (Claude) | ✅ | ❌ No `ANTHROPIC_API_KEY` yet | ✅ fake Claude |
| Grounding pipeline | ✅ | ❌ (needs Claude) | ✅ 8 unit tests + 8 pipeline tests |
| Screenshot descriptions (vision) | ✅ | ❌ (needs Claude) | ✅ |
| Video storyboard and render | ✅ | ⚠️ FFmpeg and frames checked; storyboard needs Claude | ✅ real FFmpeg render |
| Voice-over (Azure Speech) | ✅ | ❌ No speech key | ❌ (silent mode tested) |
| Admin and chat API | ✅ | ✅ All endpoints returned 200 on the live stack | ✅ |
| Entra sign-in (API JWT + web MSAL) | ✅ | ❌ Only the dev bypass has been used | ⚠️ role checks tested with a fake verifier |
| Web UI | ✅ | ⚠️ Builds and serves; pages not clicked through in a browser | ❌ no UI tests |
| Observability, cost, budgets | ✅ | ⚠️ Traces written on the live stack | ✅ |
| Deployment and production setup | ❌ | ❌ | ❌ |

The automated tests (`npm test`) are **84 tests in 8 files**, all passing. They need no Docker and no API keys: PGlite stands in for Postgres, plus a fake Claude and real FFmpeg.

## 2. What is complete

### Phase 1: Foundation ✅
- Monorepo, Docker Compose (Postgres with pgvector, Redis), Drizzle schema, 4 migrations.
- Connectors: OneDrive/SharePoint (Graph delta, app-only, 429 handling) and a local folder (snapshot cursor, allow-listed roots).
- Crawl job with all of the following:
  - delta, full and manual triggers; per-source cron schedulers
  - one crawl per source (Redis lock); retries and dead letters; the cursor only advances after success
  - soft deletes; rename handling; ACL refresh
  - `PARSER_VERSION` upgrades; admin overrides that survive re-crawls
- Parsing:
  - `.docx`: headings, bold numbered headings, tables with cell line breaks, lists, footer removal, images per section
  - `.pdf`: text only
- Classification: UC ID from the path, then the document header; type from content, then the folder.
- Chunking, embeddings (reused when unchanged), screenshot blobs, UCS↔UIS links.
- Admin API: sources (CRUD, preview, sync, pause), SharePoint site/folder browser, crawl runs and items, retrying failed files, documents (search, detail, override, reindex), secrets status, audit log.

### Phase 2: Answers ✅ (code complete; live Claude test pending)
- Hybrid retrieval (vector + full-text + UC hints → RRF → Voyage rerank).
- Router, cited answer, and verifier using the Claude API.
- The full grounding pipeline (ARCHITECTURE §5), with the refusal message, the `partial` outcome and gap statements.
- Chat API over SSE; conversations kept private per user; feedback.
- Traces, spans, `llm_calls`, cost from `model_prices`, budgets.

### Phase 3: Screens ✅ (live vision test pending)
- Vision descriptions with element boxes, embeddings, failure tracking, admin box editor, a "verified" flag, and "describe again".

### Phase 4: Video ✅ (live storyboard and TTS test pending)
- A video job created automatically for `ui_howto` questions, or on request from any answer with verified steps.
- Storyboard, then validation of every scene, then narration verification, then a 1080p MP4 (H.264/AAC).
- Azure TTS, or silent captions without a key; caching; stale marking when a source document changes.

### Admin web UI ✅
Pages: Overview, Sources, Crawl jobs, Documents, Screens, Sessions (decision timeline with tokens and cost per call), Usage, Videos, Insights (documentation gaps, 👎 answers, top UCs), Playground, Settings (versioned, rollback, prices, secret status), Audit.

## 3. Verification gaps: do these first

1. **Real Claude calls have never run.** Things that may need adjusting on first contact:
   - **Structured outputs on `claude-haiku-4-5`** (router, verifier) are untested. If they're rejected, switch the router and verifier models to `claude-sonnet-5-5` in Settings. No code change is needed.
   - **The shape of citations** on real answers: the block splitting, and how often lead-in text comes back uncited. `isConnective()` may need tuning. Watch the `grounding` span's `removed` list in Sessions.
   - **The `minRelevance` default (0.35) is a guess.** Calibrate it with the Playground (see Phase A).
   - **The vision boxes may be inaccurate.** Check them on the Screens page.
2. **Azure TTS** has not been called.
3. **OneDrive connector, Graph site browser and MSAL sign-in** have not run against a real Microsoft 365 tenant. The personal Azure tenant has no SharePoint subscription, so admin consent for Graph failed.
4. **The web UI** was checked with HTTP requests only. Nobody has clicked through it in a browser.

## 4. Development plan (remaining work)

Sizes: S = under 1 day, M = 1–3 days, L = more than 3 days.

### Phase A: Validate with real Claude (next)
| # | Task | Size | Done when |
|---|---|---|---|
| A1 | Add `ANTHROPIC_API_KEY`, restart the worker and API, run the end-to-end checklist in [DEVELOPMENT.md §6](DEVELOPMENT.md#6-end-to-end-checklist) | S | Answer, refusal, partial and video flows all work; traces show the expected spans |
| A2 | Calibrate `minRelevance` and `maxRemovedRatio`: run about 30 in-scope and 20 out-of-scope questions in the Playground and record the top relevance scores | S | No in-scope question refused for low relevance; no out-of-scope question answered |
| A3 | Add `AZURE_SPEECH_KEY` and `AZURE_SPEECH_REGION`; check a voiced video | S | Voice and frames stay in sync |
| A4 | Build evaluation sets as a script plus JSON files: about 50 question→UC pairs (recall@5 ≥ 90%), about 40 routing labels (≥ 90%), about 50 out-of-scope and adversarial questions (**100% refused**), and a faithfulness check (≥ 98% supported claims) | M | `npm run eval` prints the scores and can run in CI |
| A5 | Click through every web page in a browser and fix UI issues; add a few Playwright smoke tests | M | Every page works; smoke tests pass |

### Phase B: Move to the company Microsoft 365 tenant
| # | Task | Size | Done when |
|---|---|---|---|
| B1 | Register the Entra app in the company tenant (README "Entra ID setup"); IT grants `Sites.Selected` (or `Files.Read.All`) and grants the app read access to the specs site | S (needs IT) | `scripts/check-credentials.ts` shows the Graph permission |
| B2 | Remove `AUTH_DEV_ROLES`; test MSAL sign-in, app roles and the developer default audience | S | Sign-in works; non-admins get 403 on admin routes |
| B3 | Add the SharePoint source with the wizard; check the preview classification against the real naming; adjust `ucIdPattern` and type rules | S | Preview shows the correct UC ID and type for the real files |
| B4 | **Decide the UCS↔UIS linking key.** The samples carry IDs such as `UIS-MTP-TAXNOTICES-01` and no UC number. If the real documents link by module code, extend `extractUcId`/`uc_links` to use it | M | Every UIS links to its UCS |
| B5 | Run `scripts/inspect-doc.ts` on a variety of real documents; extend `parsers/docx.ts` for any new heading or table styles, then bump `PARSER_VERSION` | M | Sections and screenshots come out correctly |
| B6 | Turn on `ACL_TRIMMING`: configure the `groups` claim in the token; confirm that `OneDriveConnector.getAcl` returns the principals that matter (inherited site permissions may need the site's groups) | M | A user without access to a document never gets it cited |
| B7 | If the specs include PDFs with screenshots: extract images from PDFs (render pages or pull embedded images) | M | PDF screenshots appear on the Screens page |

### Phase C: Production readiness
| # | Task | Size |
|---|---|---|
| C1 | Make the **first git commit**, push to the company repository, set up branch protection | S |
| C2 | Dockerfiles for the API and worker (the worker needs the `ffmpeg-static` binary, or system FFmpeg), plus the web static build (served by nginx or the API) | M |
| C3 | Azure hosting: Container Apps or App Service; Azure Database for PostgreSQL Flexible Server with the `vector` extension; Azure Cache for Redis; Key Vault references for secrets | L |
| C4 | `AzureBlobStore` implementing `BlobStore` (`packages/ingestion/src/blob.ts`). Today only `LocalBlobStore` exists | S |
| C5 | CI pipeline: `npm ci`, `npm run typecheck`, `npm test`, eval (A4), image builds | M |
| C6 | Hardening: HTTPS; CORS if the web app is served from another origin (today Vite proxies `/api`); per-user rate limiting on `/chat`; request size limits | M |
| C7 | Monitoring: ship pino logs and OpenTelemetry to Application Insights; alerts on worker failures and dead letters | M |
| C8 | Postgres backups and a restore test | S |

### Phase D: Remaining features from the plan
| # | Task | Size |
|---|---|---|
| D1 | **Graph change-notification webhooks**: subscription create and renew (every ~2 days), a `POST /webhooks/graph` validation handler, queueing a delta crawl. Columns `webhook_subscription_id` and `webhook_expires_at` already exist. Needs `PUBLIC_BASE_URL` | M |
| D2 | **Retention job**: delete traces, spans and `llm_calls` details older than 90 days, but keep daily cost totals | S |
| D3 | Enforce the **`video.maxSeconds` setting** (it exists in Settings but is unused; only `maxScenes` is enforced) | S |
| D4 | **Budget alerts** by email or Teams at 80% and 100% (today it's an admin banner only) | S |
| D5 | Delete blob-store files that no screen or video references any more (deleted documents leave files behind) | S |
| D6 | Nicer videos: Ken Burns or crossfade transitions, word-timed subtitles from Azure TTS word boundaries | M |
| D7 | Google Drive connector (implement `SourceConnector`) | M |
| D8 | Proper `clarify` handling: ask a follow-up question instead of treating it as `explain` | S |
| D9 | Box editor: drag to draw or resize boxes instead of typing numbers | M |
| D10 | Optional: Langfuse or OpenTelemetry export of spans | M |

## 5. Known issues and risks

| Issue | Impact | Notes |
|---|---|---|
| `AUTH_DEV_ROLES` is set in the local `.env` | Anyone who can reach the API is an admin | Fine on localhost only. **Remove it before exposing the API** (B2) |
| Answer quality depends on document structure | Specs without headings or bold numbered headings become one large section | Check with `scripts/inspect-doc.ts`; extend the parser (B5) |
| The relevance threshold isn't calibrated | Too high: valid questions refused. Too low: weak matches get through (grounding still blocks invented text) | A2 |
| Vision boxes are approximate | Highlights can be slightly off | Admins correct and verify on the Screens page |
| Haiku structured outputs untested | Router or verifier errors on the first live run | Switch the models in Settings (A1) |
| Rename detection in local folders is delete + add | Embeddings are recomputed for renamed local files | OneDrive keeps stable IDs, so this doesn't happen there |
| Video rendering runs on the worker CPU | Long videos slow other jobs (concurrency 2) | Split into a separate queue/worker if needed |
| The blob store is on local disk | Not shared across instances | C4 |
| `ffmpeg-static` downloads its binary in an install script | npm 11 blocks install scripts by default | `npm install-scripts approve ffmpeg-static` (already approved on the dev machine) |

## 6. Open questions for the business

1. **ID scheme.** How do real UCS and UIS documents identify each other: UC numbers, module codes (`MTP-TAXNOTICES`), or something else? This decides B4.
2. **Location and access.** Which SharePoint site and folders hold the specs? Should every employee see every spec, or should access follow SharePoint permissions (B6)?
3. **Hosting.** Which Azure subscription and region? Any data-residency rules for sending document text to the Claude API and Voyage AI?
4. **Budgets.** What are the real daily and monthly limits? The defaults are $20/day, $300/month and $2 per user per day.
5. **Voice.** Which voice and language for the video guides (default `en-US-JennyNeural`)?
