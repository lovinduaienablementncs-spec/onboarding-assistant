CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"user_name" text,
	"title" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"rating" integer NOT NULL,
	"comment" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "llm_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trace_id" uuid,
	"user_id" text,
	"step" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cache_read_tokens" integer DEFAULT 0 NOT NULL,
	"cache_write_tokens" integer DEFAULT 0 NOT NULL,
	"units" double precision DEFAULT 0 NOT NULL,
	"cost_usd" double precision DEFAULT 0 NOT NULL,
	"latency_ms" integer DEFAULT 0 NOT NULL,
	"stop_reason" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"outcome" text,
	"payload" jsonb,
	"trace_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "model_prices" (
	"model" text PRIMARY KEY NOT NULL,
	"input_per_m" double precision NOT NULL,
	"output_per_m" double precision DEFAULT 0 NOT NULL,
	"cache_read_per_m" double precision DEFAULT 0 NOT NULL,
	"cache_write_per_m" double precision DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "spans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"ordinal" integer NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"duration_ms" integer NOT NULL,
	"data" jsonb NOT NULL,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "traces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"conversation_id" uuid,
	"user_id" text,
	"user_name" text,
	"question" text,
	"outcome" text,
	"cost_usd" double precision DEFAULT 0 NOT NULL,
	"duration_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "video_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cache_key" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"question" text NOT NULL,
	"uc_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source_doc_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"input" jsonb NOT NULL,
	"storyboard" jsonb,
	"blob_key" text,
	"duration_sec" double precision,
	"has_voice" boolean DEFAULT false NOT NULL,
	"trace_id" uuid,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "screens" ADD COLUMN "context" text;--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_calls" ADD CONSTRAINT "llm_calls_trace_id_traces_id_fk" FOREIGN KEY ("trace_id") REFERENCES "public"."traces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spans" ADD CONSTRAINT "spans_trace_id_traces_id_fk" FOREIGN KEY ("trace_id") REFERENCES "public"."traces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversations_user_idx" ON "conversations" USING btree ("user_id","updated_at");--> statement-breakpoint
CREATE INDEX "llm_calls_created_idx" ON "llm_calls" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "llm_calls_trace_idx" ON "llm_calls" USING btree ("trace_id");--> statement-breakpoint
CREATE INDEX "messages_conversation_idx" ON "messages" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "spans_trace_idx" ON "spans" USING btree ("trace_id");--> statement-breakpoint
CREATE INDEX "traces_created_idx" ON "traces" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "traces_user_idx" ON "traces" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "video_jobs_cache_idx" ON "video_jobs" USING btree ("cache_key");--> statement-breakpoint
-- Starting prices in USD per million tokens (TTS: per million characters). Editable from the admin UI.
INSERT INTO "model_prices" ("model", "input_per_m", "output_per_m", "cache_read_per_m", "cache_write_per_m") VALUES
  ('claude-opus-5-5', 4, 20, 0.2, 5),
  ('claude-sonnet-5-5', 2, 10, 0.2, 2.5),
  ('claude-haiku-4-5', 1, 5, 0.1, 1.25),
  ('voyage-3.5', 0.06, 0, 0, 0),
  ('rerank-2.5', 0.05, 0, 0, 0),
  ('azure-tts-neural', 16, 0, 0, 0)
ON CONFLICT ("model") DO NOTHING;
