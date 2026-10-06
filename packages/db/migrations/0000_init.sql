CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_id" text NOT NULL,
	"actor_name" text,
	"action" text NOT NULL,
	"entity" text NOT NULL,
	"entity_id" text,
	"before" jsonb,
	"after" jsonb,
	"ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"uc_id" text,
	"doc_type" text NOT NULL,
	"section" text NOT NULL,
	"heading_path" jsonb NOT NULL,
	"ordinal" integer NOT NULL,
	"text" text NOT NULL,
	"text_hash" text NOT NULL,
	"embedding" vector(1024),
	"tsv" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', "text")) STORED,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crawl_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"path" text NOT NULL,
	"action" text NOT NULL,
	"status" text NOT NULL,
	"attempts" integer DEFAULT 1 NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crawl_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"trigger" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"added" integer DEFAULT 0 NOT NULL,
	"updated" integer DEFAULT 0 NOT NULL,
	"deleted" integer DEFAULT 0 NOT NULL,
	"unchanged" integer DEFAULT 0 NOT NULL,
	"failed" integer DEFAULT 0 NOT NULL,
	"embedding_tokens" integer DEFAULT 0 NOT NULL,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"path" text NOT NULL,
	"name" text NOT NULL,
	"web_url" text NOT NULL,
	"uc_id" text,
	"doc_type" text NOT NULL,
	"uc_id_override" text,
	"doc_type_override" text,
	"ctag" text,
	"content_hash" text,
	"version" integer DEFAULT 0 NOT NULL,
	"acl" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"last_indexed_at" timestamp with time zone,
	"last_error" text,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "screens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"uc_id" text,
	"ordinal" integer NOT NULL,
	"image_hash" text NOT NULL,
	"blob_key" text NOT NULL,
	"content_type" text NOT NULL,
	"caption" text,
	"description" jsonb,
	"embedding" vector(1024),
	"verified" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"value" jsonb NOT NULL,
	"version" integer NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"changed_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"connector" text NOT NULL,
	"drive_id" text NOT NULL,
	"folder_path" text DEFAULT '/' NOT NULL,
	"include_globs" jsonb DEFAULT '["**/*"]'::jsonb NOT NULL,
	"exclude_globs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"file_types" jsonb DEFAULT '["docx","pdf"]'::jsonb NOT NULL,
	"uc_id_pattern" text NOT NULL,
	"doc_type_rules" jsonb NOT NULL,
	"delta_cron" text NOT NULL,
	"full_cron" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"delta_link" text,
	"webhook_subscription_id" text,
	"webhook_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "uc_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"uc_id" text NOT NULL,
	"ucs_document_id" uuid,
	"uis_document_id" uuid,
	"origin" text DEFAULT 'auto' NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crawl_items" ADD CONSTRAINT "crawl_items_run_id_crawl_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."crawl_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crawl_runs" ADD CONSTRAINT "crawl_runs_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "screens" ADD CONSTRAINT "screens_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "uc_links" ADD CONSTRAINT "uc_links_ucs_document_id_documents_id_fk" FOREIGN KEY ("ucs_document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "uc_links" ADD CONSTRAINT "uc_links_uis_document_id_documents_id_fk" FOREIGN KEY ("uis_document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_created_idx" ON "audit_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "chunks_document_idx" ON "chunks" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "chunks_embedding_idx" ON "chunks" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "chunks_tsv_idx" ON "chunks" USING gin ("tsv");--> statement-breakpoint
CREATE INDEX "crawl_items_run_idx" ON "crawl_items" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "crawl_runs_source_idx" ON "crawl_runs" USING btree ("source_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "documents_source_external_uq" ON "documents" USING btree ("source_id","external_id");--> statement-breakpoint
CREATE INDEX "documents_uc_id_idx" ON "documents" USING btree ("uc_id");--> statement-breakpoint
CREATE INDEX "screens_document_idx" ON "screens" USING btree ("document_id");--> statement-breakpoint
CREATE UNIQUE INDEX "settings_key_version_uq" ON "settings" USING btree ("key","version");--> statement-breakpoint
CREATE UNIQUE INDEX "uc_links_uq" ON "uc_links" USING btree ("uc_id","ucs_document_id","uis_document_id");