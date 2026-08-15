import { z } from 'zod';

import {
  AttachedMemoryMissSchema,
  type AttachedMemoryMiss,
} from '@agent/types/AttachedMemory';

/**
 * The fixed template-variable vocabulary `buildUserVars`
 * (`@agent/prompt/userVars`) produces for prompt rendering — one known type
 * per runtime token. The type is closed on purpose: a misspelled fixed
 * variable is a compile error at the producer and at every typed reader
 * instead of a silently empty substitution.
 *
 * Agent-YAML `requiredFilesInternal` variables have user-defined names, so
 * they are not in this vocabulary; they ride beside it as custom string keys
 * (see {@link TemplateVars}) and only templates read them.
 *
 * The type lives beside the channels below, not in the prompt layer, because
 * `UserVariableChannels` (persisted and resumed by the tool-use flow) is its
 * primary carrier — `definition` may not import back from `agent/prompt`.
 */
export type UserVars = {
  /** Live model id for the run. */
  MODEL: string;
  /** Current user instruction. */
  INSTRUCTION: string;
  /** Provider gates for provider-specific prompt blocks. */
  IS_OPENAI_MODEL: boolean;
  IS_ANTHROPIC_MODEL: boolean;
  IS_GOOGLE_MODEL: boolean;
  /** Pre-rendered delegation rosters (the run's own agent excluded). */
  WORKFLOW_AGENTS: string;
  TOOL_USE_AGENTS: string;
  /** Workspace root the run operates in. */
  CWD: string;
  /** Configured default bibliography path, '' when unset. */
  DEFAULT_BIB_PATH: string;
  /** Absolute agent-directory paths from the external-roots registry, '' when unregistered. */
  BUILTIN_WORKFLOW_DIR: string;
  BUILTIN_TOOLUSE_DIR: string;
  CUSTOM_AGENTS_DIR: string;
  AGENT_DOCS_DIR: string;
  /** Per-category primary file and its content, null when none is readable. */
  INPUT_FILE: string | null;
  INPUT_CONTENT: string | null;
  CONTEXT_FILE: string | null;
  CONTEXT_CONTENT: string | null;
  EDITED_FILE: string | null;
  EDITED_CONTENT: string | null;
  /** Per-category readable files as prompt-displayed names. */
  INPUT_FILES: string[];
  CONTEXT_FILES: string[];
  EDITED_FILES: string[];
  /** Per-category XML bundle of readable files, null when none are readable. */
  ALL_INPUTS: string | null;
  ALL_CONTEXTS: string | null;
  ALL_EDITEDS: string | null;
  /** Per-category comma-separated readable file list, '' when empty. */
  LIST_OF_ALL_INPUTS: string;
  LIST_OF_ALL_CONTEXTS: string;
  LIST_OF_ALL_EDITEDS: string;
  /** First attached media file; content is never inlined (display-only). */
  MEDIA_FILE: string | null;
  MEDIA_CONTENT: null;
  /** Resolved output file list; absent when no usable outputs are configured. */
  OUTPUT_FILES?: string[];
  /** Tool toggles projected for template conditionals. */
  AUTO_EXTRACT_FIGURE: boolean;
  AUTO_EXTRACT_TIKZ_FIGURE: boolean;
  INCLUDE_TEX_COUNT: boolean;
  PRINT_INPUT_PROMPT: boolean;
  AUTO_COMPILE_INPUT_PDF: boolean;
  /** When-to-choose guidance, '' when the tool is not on the roster. */
  CODEX_GUIDANCE: string;
  CLAUDE_CODE_GUIDANCE: string;
  /** Effective round count; workflow agents only. */
  ROUNDS?: number;
  /** Shared LaTeX style rules text, '' when the file is missing. */
  LATEX_STYLE_RULES: string;
  /** XML block of attached memory contents, null when none are attached. */
  ATTACHED_MEMORIES: string | null;
  /** Attached memories that could not be read. */
  ATTACHED_MEMORY_MISSES: AttachedMemoryMiss[];
  /** Pre-rendered skill catalog, '' when skills are disabled or unavailable. */
  AVAILABLE_SKILLS: string;
};

/**
 * The template-variable map accepted at the render boundary (PromptBuilder,
 * the user-variable channels). Fixed variables may be absent — template
 * rendering keeps `throwOnUndefined` off, so templates must tolerate absence
 * — and agent-defined `requiredFilesInternal` variables add custom keys
 * beside the fixed ones.
 */
export type TemplateVars = Partial<UserVars> & Record<string, unknown>;

/**
 * Runtime validators for the fixed {@link UserVars} keys. Known keys are
 * optional here because persisted checkpoints may have dropped variables; the
 * `satisfies` clause keeps this map in lockstep with the vocabulary. Custom
 * `requiredFilesInternal` keys are not in this map and pass through as
 * unknown values via the loose record below.
 */
const UserVariableValueSchemas = {
  MODEL: z.string(),
  INSTRUCTION: z.string(),
  IS_OPENAI_MODEL: z.boolean(),
  IS_ANTHROPIC_MODEL: z.boolean(),
  IS_GOOGLE_MODEL: z.boolean(),
  WORKFLOW_AGENTS: z.string(),
  TOOL_USE_AGENTS: z.string(),
  CWD: z.string(),
  DEFAULT_BIB_PATH: z.string(),
  BUILTIN_WORKFLOW_DIR: z.string(),
  BUILTIN_TOOLUSE_DIR: z.string(),
  CUSTOM_AGENTS_DIR: z.string(),
  AGENT_DOCS_DIR: z.string(),
  INPUT_FILE: z.string().nullable(),
  INPUT_CONTENT: z.string().nullable(),
  CONTEXT_FILE: z.string().nullable(),
  CONTEXT_CONTENT: z.string().nullable(),
  EDITED_FILE: z.string().nullable(),
  EDITED_CONTENT: z.string().nullable(),
  INPUT_FILES: z.array(z.string()),
  CONTEXT_FILES: z.array(z.string()),
  EDITED_FILES: z.array(z.string()),
  ALL_INPUTS: z.string().nullable(),
  ALL_CONTEXTS: z.string().nullable(),
  ALL_EDITEDS: z.string().nullable(),
  LIST_OF_ALL_INPUTS: z.string(),
  LIST_OF_ALL_CONTEXTS: z.string(),
  LIST_OF_ALL_EDITEDS: z.string(),
  MEDIA_FILE: z.string().nullable(),
  MEDIA_CONTENT: z.null(),
  OUTPUT_FILES: z.array(z.string()),
  AUTO_EXTRACT_FIGURE: z.boolean(),
  AUTO_EXTRACT_TIKZ_FIGURE: z.boolean(),
  INCLUDE_TEX_COUNT: z.boolean(),
  PRINT_INPUT_PROMPT: z.boolean(),
  AUTO_COMPILE_INPUT_PDF: z.boolean(),
  CODEX_GUIDANCE: z.string(),
  CLAUDE_CODE_GUIDANCE: z.string(),
  ROUNDS: z.number(),
  LATEX_STYLE_RULES: z.string(),
  ATTACHED_MEMORIES: z.string().nullable(),
  ATTACHED_MEMORY_MISSES: z.array(AttachedMemoryMissSchema),
  AVAILABLE_SKILLS: z.string(),
} satisfies {
  [K in keyof Required<UserVars>]-?: z.ZodType<Required<UserVars>[K]>;
};

function optionalizeUserVariableSchemas<T extends Record<string, z.ZodTypeAny>>(
  schemas: T,
): { [K in keyof T]: z.ZodOptional<T[K]> } {
  return Object.fromEntries(
    Object.entries(schemas).map(([key, schema]) => [key, schema.optional()]),
  ) as { [K in keyof T]: z.ZodOptional<T[K]> };
}

/**
 * The persisted channel shape stays a loose record — checkpoints written by
 * older versions may carry renamed or dropped variables and must still parse
 * — but each known fixed key is validated with its per-key type when present.
 * Custom `requiredFilesInternal` keys pass through untouched.
 */
const UserVariableChannelRecordSchema = z.looseObject(
  optionalizeUserVariableSchemas(UserVariableValueSchemas),
);

/**
 * User variable channels for template rendering.
 *
 * Two-channel design:
 * - input: Frozen base variables (readonly, set at initialization)
 * - transient: Runtime modifications (mutable copy of base)
 */
export const UserVariableChannelsSchema = z.object({
  input: UserVariableChannelRecordSchema.readonly(),
  transient: UserVariableChannelRecordSchema,
});

/** Derived from UserVariableChannelsSchema - single source of truth. */
export type UserVariableChannels = z.output<typeof UserVariableChannelsSchema>;
