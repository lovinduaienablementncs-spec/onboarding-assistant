import { sql } from "drizzle-orm";
import {
  boolean,
  customType,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
} from "drizzle-orm/pg-core";
import type { DocTypeRule, ScreenDescription } from "@oa/shared";

/** voyage-3.5 default output dimension. */
export const EMBEDDING_DIM = 1024;

const tsvector = customType<{ data: string }>({ dataType: () => "tsvector" });

const id = () => uuid("id").primaryKey().defaultRandom();
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

export const sources = pgTable("sources", {
  id: id(),
  name: text("name").notNull(),
  connector: text("connector").notNull(),
  driveId: text("drive_id").notNull(),
  folderPath: text("folder_path").notNull().default("/"),
  includeGlobs: jsonb("include_globs").$type<string[]>().notNull().default(["**/*"]),
  excludeGlobs: jsonb("exclude_globs").$type<string[]>().notNull().default([]),
  fileTypes: jsonb("file_types").$type<string[]>().notNull().default(["docx", "pdf"]),
  ucIdPattern: text("uc_id_pattern").notNull(),
  docTypeRules: jsonb("doc_type_rules").$type<DocTypeRule[]>().notNull(),
  deltaCron: text("delta_cron").notNull(),
  fullCron: text("full_cron").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  /** Graph deltaLink; advanced only after a successful run. */
  deltaLink: text("delta_link"),
  webhookSubscriptionId: text("webhook_subscription_id"),
  webhookExpiresAt: timestamp("webhook_expires_at", { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const documents = pgTable(
  "documents",
  {
    id: id(),
    sourceId: uuid("source_id").notNull().references(() => sources.id, { onDelete: "cascade" }),
    /** The connector's stable item id (Graph driveItem id). */
    externalId: text("external_id").notNull(),
    path: text("path").notNull(),
    name: text("name").notNull(),
    webUrl: text("web_url").notNull(),
    ucId: text("uc_id"),
    docType: text("doc_type").notNull(),
    /** Admin corrections; the crawler uses these instead of re-detecting from the path. */
    ucIdOverride: text("uc_id_override"),
    docTypeOverride: text("doc_type_override"),
    /** Graph cTag: changes only when file content changes (eTag also changes on rename). */
    cTag: text("ctag"),
    contentHash: text("content_hash"),
    version: integer("version").notNull().default(0),
    /** PARSER_VERSION that produced the current chunks; older ones are re-read on the next crawl. */
    parserVersion: integer("parser_version").notNull().default(0),
    acl: jsonb("acl").$type<string[]>().notNull().default([]),
    /** pending | indexed | failed | deleted */
    status: text("status").notNull().default("pending"),
    lastIndexedAt: timestamp("last_indexed_at", { withTimezone: true }),
    lastError: text("last_error"),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("documents_source_external_uq").on(t.sourceId, t.externalId),
    index("documents_uc_id_idx").on(t.ucId),
  ],
);

export const chunks = pgTable(
  "chunks",
  {
    id: id(),
    documentId: uuid("document_id").notNull().references(() => documents.id, { onDelete: "cascade" }),
    ucId: text("uc_id"),
    docType: text("doc_type").notNull(),
    section: text("section").notNull(),
    headingPath: jsonb("heading_path").$type<string[]>().notNull(),
    ordinal: integer("ordinal").notNull(),
    text: text("text").notNull(),
    textHash: text("text_hash").notNull(),
    embedding: vector("embedding", { dimensions: EMBEDDING_DIM }),
    tsv: tsvector("tsv").generatedAlwaysAs(sql`to_tsvector('english', "text")`),
    createdAt: createdAt(),
  },
  (t) => [
    index("chunks_document_idx").on(t.documentId),
    index("chunks_embedding_idx").using("hnsw", t.embedding.op("vector_cosine_ops")),
    index("chunks_tsv_idx").using("gin", t.tsv),
  ],
);

export const screens = pgTable(
  "screens",
  {
    id: id(),
    documentId: uuid("document_id").notNull().references(() => documents.id, { onDelete: "cascade" }),
    ucId: text("uc_id"),
    ordinal: integer("ordinal").notNull(),
    imageHash: text("image_hash").notNull(),
    blobKey: text("blob_key").notNull(),
    contentType: text("content_type").notNull(),
    caption: text("caption"),
    /** Text of the UIS section the screenshot sits in; given to the vision step as context. */
    context: text("context"),
    /** Filled by the vision step; boxes can be corrected by an admin. */
    description: jsonb("description").$type<ScreenDescription>(),
    embedding: vector("embedding", { dimensions: EMBEDDING_DIM }),
    verified: boolean("verified").notNull().default(false),
    /** Last vision failure (unsupported image format, API error); cleared on success. */
    describeError: text("describe_error"),
    createdAt: createdAt(),
  },
  (t) => [index("screens_document_idx").on(t.documentId)],
);

export const ucLinks = pgTable(
  "uc_links",
  {
    id: id(),
    ucId: text("uc_id").notNull(),
    ucsDocumentId: uuid("ucs_document_id").references(() => documents.id, { onDelete: "cascade" }),
    uisDocumentId: uuid("uis_document_id").references(() => documents.id, { onDelete: "cascade" }),
    /** auto | manual (admin override) */
    origin: text("origin").notNull().default("auto"),
  },
  (t) => [uniqueIndex("uc_links_uq").on(t.ucId, t.ucsDocumentId, t.uisDocumentId)],
);

export const crawlRuns = pgTable(
  "crawl_runs",
  {
    id: id(),
    sourceId: uuid("source_id").notNull().references(() => sources.id, { onDelete: "cascade" }),
    trigger: text("trigger").notNull(),
    /** running | succeeded | failed */
    status: text("status").notNull().default("running"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    added: integer("added").notNull().default(0),
    updated: integer("updated").notNull().default(0),
    deleted: integer("deleted").notNull().default(0),
    unchanged: integer("unchanged").notNull().default(0),
    failed: integer("failed").notNull().default(0),
    embeddingTokens: integer("embedding_tokens").notNull().default(0),
    error: text("error"),
  },
  (t) => [index("crawl_runs_source_idx").on(t.sourceId, t.startedAt)],
);

export const crawlItems = pgTable(
  "crawl_items",
  {
    id: id(),
    runId: uuid("run_id").notNull().references(() => crawlRuns.id, { onDelete: "cascade" }),
    externalId: text("external_id").notNull(),
    path: text("path").notNull(),
    /** added | updated | renamed | deleted | unchanged | skipped */
    action: text("action").notNull(),
    /** ok | failed | dead */
    status: text("status").notNull(),
    attempts: integer("attempts").notNull().default(1),
    error: text("error"),
    createdAt: createdAt(),
  },
  (t) => [index("crawl_items_run_idx").on(t.runId)],
);

export const settings = pgTable(
  "settings",
  {
    id: id(),
    key: text("key").notNull(),
    value: jsonb("value").notNull(),
    version: integer("version").notNull(),
    active: boolean("active").notNull().default(true),
    changedBy: text("changed_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("settings_key_version_uq").on(t.key, t.version)],
);

export const auditLog = pgTable(
  "audit_log",
  {
    id: id(),
    actorId: text("actor_id").notNull(),
    actorName: text("actor_name"),
    action: text("action").notNull(),
    entity: text("entity").notNull(),
    entityId: text("entity_id"),
    before: jsonb("before"),
    after: jsonb("after"),
    ip: text("ip"),
    createdAt: createdAt(),
  },
  (t) => [index("audit_log_created_idx").on(t.createdAt)],
);

// ---- Chat ----

export const conversations = pgTable(
  "conversations",
  {
    id: id(),
    userId: text("user_id").notNull(),
    userName: text("user_name"),
    title: text("title").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("conversations_user_idx").on(t.userId, t.updatedAt)],
);

export const messages = pgTable(
  "messages",
  {
    id: id(),
    conversationId: uuid("conversation_id").notNull().references(() => conversations.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    content: text("content").notNull(),
    /** answered | partial | refused | error (assistant messages only) */
    outcome: text("outcome"),
    /** Citations, sources, intent, video job id. */
    payload: jsonb("payload").$type<Record<string, unknown>>(),
    traceId: uuid("trace_id"),
    createdAt: createdAt(),
  },
  (t) => [index("messages_conversation_idx").on(t.conversationId, t.createdAt)],
);

export const feedback = pgTable("feedback", {
  id: id(),
  messageId: uuid("message_id").notNull().references(() => messages.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull(),
  /** 1 = thumbs up, -1 = thumbs down */
  rating: integer("rating").notNull(),
  comment: text("comment"),
  createdAt: createdAt(),
});

// ---- Observability ----

/** One trace per user message (or per background job such as vision or video). */
export const traces = pgTable(
  "traces",
  {
    id: id(),
    kind: text("kind").notNull(),
    conversationId: uuid("conversation_id"),
    userId: text("user_id"),
    userName: text("user_name"),
    question: text("question"),
    /** answered | partial | refused | error | ok */
    outcome: text("outcome"),
    costUsd: doublePrecision("cost_usd").notNull().default(0),
    durationMs: integer("duration_ms"),
    createdAt: createdAt(),
  },
  (t) => [index("traces_created_idx").on(t.createdAt), index("traces_user_idx").on(t.userId)],
);

/** One span per pipeline step, holding that step's structured inputs and decisions. */
export const spans = pgTable(
  "spans",
  {
    id: id(),
    traceId: uuid("trace_id").notNull().references(() => traces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    ordinal: integer("ordinal").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    durationMs: integer("duration_ms").notNull(),
    data: jsonb("data").$type<Record<string, unknown>>().notNull(),
    error: text("error"),
  },
  (t) => [index("spans_trace_idx").on(t.traceId)],
);

/** Every model/API call with its token usage and cost. */
export const llmCalls = pgTable(
  "llm_calls",
  {
    id: id(),
    traceId: uuid("trace_id").references(() => traces.id, { onDelete: "set null" }),
    userId: text("user_id"),
    step: text("step").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
    cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),
    /** TTS characters, render seconds and other non-token units. */
    units: doublePrecision("units").notNull().default(0),
    costUsd: doublePrecision("cost_usd").notNull().default(0),
    latencyMs: integer("latency_ms").notNull().default(0),
    stopReason: text("stop_reason"),
    error: text("error"),
    createdAt: createdAt(),
  },
  (t) => [index("llm_calls_created_idx").on(t.createdAt), index("llm_calls_trace_idx").on(t.traceId)],
);

/** Prices per million tokens (or per million units); admins can update them. */
export const modelPrices = pgTable("model_prices", {
  model: text("model").primaryKey(),
  inputPerM: doublePrecision("input_per_m").notNull(),
  outputPerM: doublePrecision("output_per_m").notNull().default(0),
  cacheReadPerM: doublePrecision("cache_read_per_m").notNull().default(0),
  cacheWritePerM: doublePrecision("cache_write_per_m").notNull().default(0),
  updatedAt: updatedAt(),
});

// ---- Video ----

export const videoJobs = pgTable(
  "video_jobs",
  {
    id: id(),
    /** Same question over the same document versions reuses the job. */
    cacheKey: text("cache_key").notNull(),
    /** queued | storyboard | rendering | ready | failed | stale */
    status: text("status").notNull().default("queued"),
    question: text("question").notNull(),
    ucIds: jsonb("uc_ids").$type<string[]>().notNull().default([]),
    sourceDocIds: jsonb("source_doc_ids").$type<string[]>().notNull().default([]),
    /** Input for the storyboard: verified steps and candidate screens. */
    input: jsonb("input").$type<Record<string, unknown>>().notNull(),
    storyboard: jsonb("storyboard").$type<Record<string, unknown>>(),
    blobKey: text("blob_key"),
    durationSec: doublePrecision("duration_sec"),
    hasVoice: boolean("has_voice").notNull().default(false),
    traceId: uuid("trace_id"),
    error: text("error"),
    createdAt: createdAt(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [index("video_jobs_cache_idx").on(t.cacheKey)],
);
