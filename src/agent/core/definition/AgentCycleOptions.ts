import { z } from 'zod';

import type { AttachedMemoryMiss } from '@agent/types/AttachedMemory';

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
 * User variable channels for template rendering.
 *
 * Two-channel design:
 * - input: Frozen base variables (readonly, set at initialization)
 * - transient: Runtime modifications (mutable copy of base)
 */
export interface UserVariableChannels {
  input: Readonly<TemplateVars>;
  transient: TemplateVars;
}

/**
 * The persisted channel shape stays an open record — checkpoints written by
 * older versions may carry renamed or dropped variables and must still parse.
 * In memory the channels always hold the `buildUserVars` product, so the
 * transform asserts the typed view once here rather than at every reader.
 */
export const UserVariableChannelsSchema = z
  .object({
    input: z.record(z.string(), z.unknown()).readonly(),
    transient: z.record(z.string(), z.unknown()),
  })
  .transform((channels) => channels as UserVariableChannels);
