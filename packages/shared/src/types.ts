import { z } from "zod";

export const DocType = z.enum(["UCS", "UIS", "OTHER"]);
export type DocType = z.infer<typeof DocType>;

export const Role = z.enum(["Assistant.Admin", "Assistant.ContentReviewer", "Assistant.Developer", "Assistant.User"]);
export type Role = z.infer<typeof Role>;

export const CrawlTrigger = z.enum(["webhook", "schedule", "full", "manual"]);
export type CrawlTrigger = z.infer<typeof CrawlTrigger>;

/** Rules an admin configures per source to classify files as UCS or UIS. */
export const DocTypeRule = z.object({
  type: DocType,
  /** Case-insensitive regex tested against the file path (folder + name). */
  pathPattern: z.string(),
});
export type DocTypeRule = z.infer<typeof DocTypeRule>;

export const SourceConfig = z.object({
  name: z.string().min(1),
  connector: z.enum(["onedrive", "local"]),
  /** onedrive: the Graph drive id. local: the folder on disk (must be under LOCAL_SOURCE_ROOTS). */
  driveId: z.string().min(1),
  folderPath: z.string().default("/"),
  includeGlobs: z.array(z.string()).default(["**/*"]),
  excludeGlobs: z.array(z.string()).default([]),
  fileTypes: z.array(z.enum(["docx", "pdf"])).default(["docx", "pdf"]),
  ucIdPattern: z.string().default("UC[-_ ]?\\d{2,4}"),
  docTypeRules: z.array(DocTypeRule).default([
    { type: "UIS", pathPattern: "\\bUIS\\b|UI[-_ ]?Spec" },
    { type: "UCS", pathPattern: "\\bUCS\\b|Use[-_ ]?Case" },
  ]),
  deltaCron: z.string().default("*/30 * * * *"),
  fullCron: z.string().default("0 2 * * *"),
  enabled: z.boolean().default(true),
});
export type SourceConfig = z.infer<typeof SourceConfig>;

/** A section of a parsed document, in reading order. */
export interface ParsedSection {
  headingPath: string[];
  text: string;
  /** Images that appear inside this section, in order. */
  images: ParsedImage[];
}

export interface ParsedImage {
  contentType: string;
  data: Buffer;
  /** Alt text or the nearest caption, if any. */
  caption?: string;
}

export interface ParsedDocument {
  title: string;
  sections: ParsedSection[];
}

export interface ChunkDraft {
  ucId: string | null;
  docType: DocType;
  section: string;
  headingPath: string[];
  text: string;
  /** sha256 of the text, used to skip re-embedding unchanged chunks. */
  textHash: string;
  ordinal: number;
}

/** What the vision step reads from a UIS screenshot. Boxes are fractions (0-1) of the image size. */
export const UiElement = z.object({
  label: z.string(),
  type: z.string(),
  box: z.tuple([z.number(), z.number(), z.number(), z.number()]),
});
export type UiElement = z.infer<typeof UiElement>;

export const ScreenDescription = z.object({
  screenName: z.string(),
  purpose: z.string(),
  navigationPath: z.string(),
  uiElements: z.array(UiElement),
});
export type ScreenDescription = z.infer<typeof ScreenDescription>;

export const Intent = z.enum(["ui_howto", "explain", "clarify", "out_of_scope"]);
export type Intent = z.infer<typeof Intent>;

export const Audience = z.enum(["end_user", "developer"]);
export type Audience = z.infer<typeof Audience>;

/** Admin-editable assistant settings (stored versioned in the settings table under key "assistant"). */
export const AssistantSettings = z.object({
  grounding: z
    .object({
      /** Minimum rerank relevance of the best chunk; below it the assistant refuses without calling the answer model. */
      minRelevance: z.number().min(0).max(1).default(0.35),
      /** Minimum number of chunks above minRelevance. */
      minChunks: z.number().int().min(1).default(1),
      /** Chunks passed to the answer model. */
      topK: z.number().int().min(1).max(20).default(8),
      /** If more than this share of claims is removed, refuse instead of answering. */
      maxRemovedRatio: z.number().min(0).max(1).default(0.3),
      refusalMessage: z
        .string()
        .default("I can only answer from the system documentation, and I couldn't find this topic there. Try rephrasing, or ask about a specific screen or use case."),
      /** extractive: narration is the cited sentence itself; generative: rephrased, then verified. */
      narrationMode: z.enum(["extractive", "generative"]).default("generative"),
    })
    .default({}),
  models: z
    .object({
      router: z.string().default("claude-haiku-4-5"),
      answer: z.string().default("claude-opus-5-5"),
      verifier: z.string().default("claude-haiku-4-5"),
      vision: z.string().default("claude-opus-5-5"),
      storyboard: z.string().default("claude-opus-5-5"),
      answerEffort: z.enum(["low", "medium", "high"]).default("medium"),
    })
    .default({}),
  video: z
    .object({
      voice: z.string().default("en-US-JennyNeural"),
      maxScenes: z.number().int().min(2).max(15).default(8),
      maxSeconds: z.number().int().min(20).max(300).default(90),
    })
    .default({}),
  budget: z
    .object({
      dailyUsd: z.number().min(0).default(20),
      monthlyUsd: z.number().min(0).default(300),
      perUserDailyUsd: z.number().min(0).default(2),
    })
    .default({}),
});
export type AssistantSettings = z.infer<typeof AssistantSettings>;
