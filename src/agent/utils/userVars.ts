import * as path from 'node:path';

import { z } from 'zod';

import { logFileCategory, logFilesLoaded, type AgentTrace } from '@agent/trace';
import {
  AttachedMemoryMissSchema,
  type AttachedMemoryMiss,
} from '@agent/types/AttachedMemory';
import {
  AgentSetting,
  AgentPrompt,
  AgentCategory,
} from '@agent/core/definition/AgentDataclass';
import {
  resolveDelegationScopeAgents,
  type AgentEntry,
} from '@agent/index/agentRegistry';
import { shouldSaveModelIO } from '@agent/utils/debugMessageSaver';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import type { FileListEntry } from '@shared/schemas';
import type { AgentDelegationScope } from '@shared/schemas/agentRoster';
import {
  AGENT_SKILLS_CONFIG_KEY,
  AGENT_SKILLS_ENABLED_DEFAULT,
  AgentSkillsEnabledSchema,
} from '@shared/schemas/agentSkills';
import {
  loadRuntimeSkillCatalog,
  type SkillLoadIssue,
} from '@skills/runtimeSkills';
import { parseFrontmatter } from '@tools/memory/memoryMeta';
import { displayToStoragePath } from '@tools/memory/memoryUtils';
import { filterNotNull, isNonEmptyString, unique } from '@utils/core';
import { AbsoluteFS, WorkspaceFS } from '@utils/files';
import {
  getListOfFiles,
  getPromptFileName,
  getXmlFormatFromReadableFiles,
} from '@utils/prompt';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { getConfig } from '@utils/config/configUtils';
import {
  listExternalRoots,
  type ExternalRootKind,
} from '@utils/files/externalRoots';
import { setVarFromFile } from '@utils/files/varsUtils';
import { StorageFS } from '@utils/files/storageFS';

/** Relative path from an agent directory to the shared LaTeX style rules file. */
const SHARED_LATEX_RULES_REL = '../shared/latex_style_rules.txt';

/**
 * Fixed runtime template variables owned by `buildUserVars`, with the exact
 * type each builder produces. This is the single source of truth: both the
 * `UserVars` type and `USER_VAR_RUNTIME_TOKENS` are derived from it, so a
 * builder that drops or misspells a key is a compile error instead of a
 * silent runtime gap.
 *
 * Agent-creation templates render once when a YAML file is produced, then the
 * generated agent renders again at runtime. These tokens must pass through the
 * creation render literally so the runtime render can substitute them later.
 * User-defined `requiredFilesInternal` variables are intentionally not in this
 * fixed schema; they remain caller-supplied names carried as a plain
 * `Record<string, string>`, and `throwOnUndefined` stays disabled until there
 * is a separate validation story for them.
 */
const UserVarsSchema = z.object({
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
  INPUT_FILES: z.array(z.string()),
  ALL_INPUTS: z.string().nullable(),
  LIST_OF_ALL_INPUTS: z.string(),

  CONTEXT_FILE: z.string().nullable(),
  CONTEXT_CONTENT: z.string().nullable(),
  CONTEXT_FILES: z.array(z.string()),
  ALL_CONTEXTS: z.string().nullable(),
  LIST_OF_ALL_CONTEXTS: z.string(),

  EDITED_FILE: z.string().nullable(),
  EDITED_CONTENT: z.string().nullable(),
  EDITED_FILES: z.array(z.string()),
  ALL_EDITEDS: z.string().nullable(),
  LIST_OF_ALL_EDITEDS: z.string(),

  MEDIA_FILE: z.string().nullable(),
  MEDIA_CONTENT: z.null(),

  // Only set when there are usable output files at all.
  OUTPUT_FILES: z.array(z.string()).nullish(),

  AUTO_EXTRACT_FIGURE: z.boolean(),
  AUTO_EXTRACT_TIKZ_FIGURE: z.boolean(),
  INCLUDE_TEX_COUNT: z.boolean(),
  PRINT_INPUT_PROMPT: z.boolean(),
  AUTO_COMPILE_INPUT_PDF: z.boolean(),
  CODEX_GUIDANCE: z.string(),
  CLAUDE_CODE_GUIDANCE: z.string(),
  // Only computed for workflow agents, not tool-use agents.
  ROUNDS: z.number().nullish(),

  LATEX_STYLE_RULES: z.string(),
  ATTACHED_MEMORIES: z.string().nullable(),
  ATTACHED_MEMORY_MISSES: z.array(AttachedMemoryMissSchema),
  AVAILABLE_SKILLS: z.string(),
});

type KnownUserVars = z.infer<typeof UserVarsSchema>;

/**
 * User variables for prompt rendering: the fixed, known set above plus
 * caller-supplied `requiredFilesInternal` var names, which aren't part of the
 * fixed schema (see `UserVarsSchema`'s doc comment).
 */
export type UserVars = KnownUserVars & Record<string, unknown>;

export const USER_VAR_RUNTIME_TOKENS = Object.keys(
  UserVarsSchema.shape,
) as ReadonlyArray<keyof KnownUserVars>;

export function buildUserVarPassthrough(): Readonly<Record<string, string>> {
  return Object.freeze(
    Object.fromEntries(
      USER_VAR_RUNTIME_TOKENS.map((token) => [token, `{{ ${token} }}`]),
    ),
  );
}

/**
 * Information about a loaded file for prompt variable substitution.
 * Extends FileListEntry with required source and varName fields.
 * Compatible with FileListEntry (can be passed to AgentTrace.fileList).
 */
type LoadedFileEntry = FileListEntry & {
  source: string;
  varName: string;
};

/**
 * Minimal provider info needed for prompt variable rendering.
 * Eliminates the need to pass a full IModelHandler reference.
 */
export interface ModelProviderFlags {
  isOpenai: boolean;
  isAnthropic: boolean;
  isGoogle: boolean;
}

export interface BuildUserVarsOptions {
  workspacePath?: string;
  delegationAgentScope?: AgentDelegationScope | null;
}

/**
 * Result of loading the caller-supplied `requiredFilesInternal` file vars.
 * Keyed by arbitrary YAML `varName`s, not part of the fixed `UserVarsSchema`.
 */
type FileVarsResult = {
  vars: Record<string, string>;
  files: LoadedFileEntry[];
};

type AttachedMemoriesResult = {
  xml: string | null;
  misses: AttachedMemoryMiss[];
};

function formatRuntimeSkillIssue(issue: SkillLoadIssue): string {
  const location = issue.path ? ` (${issue.path})` : '';
  return `${issue.severity}: ${issue.message}${location}`;
}

/**
 * Build all user variables needed for prompt rendering.
 *
 * @param options.workspacePath - Workspace root path override. Defaults to the active workspace.
 * @param options.delegationAgentScope - Run-scoped delegation roster. Defaults to the workspace roster.
 */
export async function buildUserVars(
  agentConfig: AgentConfig,
  agentSetting: AgentSetting,
  agentPrompt: AgentPrompt,
  agentPath: string,
  providerFlags: ModelProviderFlags,
  logger: AgentTrace,
  options: BuildUserVarsOptions = {},
): Promise<UserVars> {
  // Parallelize independent I/O: required files, rules, and memories
  const [
    { vars: requiredVars, files: requiredFiles },
    latexStyleRules,
    attachedMemories,
    runtimeSkills,
  ] = await Promise.all([
    getRequiredFileVars(agentSetting, agentPath),
    // Load shared LaTeX style rules (best-effort; empty string if missing)
    AbsoluteFS.read(path.join(agentPath, SHARED_LATEX_RULES_REL)).catch(
      () => '',
    ),
    getAttachedMemories(agentConfig.memories),
    // AVAILABLE_SKILLS is only substituted into TOOL_USE_INSTRUCTIONS, so the
    // catalog (a multi-source readdir + per-skill realpath/read/parse) is dead
    // work for workflow agents. The settings toggle gives users a hard off
    // switch that skips discovery and leaves AVAILABLE_SKILLS empty.
    agentSetting.agentCategory === AgentCategory.ToolUse &&
    AgentSkillsEnabledSchema.parse(
      getConfig<unknown>(AGENT_SKILLS_CONFIG_KEY, AGENT_SKILLS_ENABLED_DEFAULT),
    )
      ? loadRuntimeSkillCatalog()
      : Promise.resolve({ catalog: '', issues: [] }),
  ]);

  for (const issue of runtimeSkills.issues) {
    logger.warn(`Skill import ${formatRuntimeSkillIssue(issue)}`);
  }

  // Merge all variable sources using spread operator.
  // LATEX_STYLE_RULES is placed last to prevent silent overrides from spreads.
  const userVars: UserVars = {
    ...getBasicVars(agentConfig, providerFlags, options),
    ...(await getFileVars(agentConfig, agentSetting, logger)),
    ...requiredVars,
    ...resolveOutputFiles(agentConfig, agentSetting),
    ...getToolFlags(agentConfig, agentSetting, agentPrompt),
    LATEX_STYLE_RULES: latexStyleRules,
    ATTACHED_MEMORIES: attachedMemories.xml,
    ATTACHED_MEMORY_MISSES: attachedMemories.misses,
    AVAILABLE_SKILLS: runtimeSkills.catalog,
  };

  // Emit aggregated file list if any files were loaded
  if (requiredFiles.length > 0) {
    logFilesLoaded(logger, 'all', requiredFiles);
  }

  return userVars;
}

function getBasicVars(
  agentConfig: AgentConfig,
  providerFlags: ModelProviderFlags,
  options: BuildUserVarsOptions,
): Pick<
  KnownUserVars,
  | 'MODEL'
  | 'INSTRUCTION'
  | 'IS_OPENAI_MODEL'
  | 'IS_ANTHROPIC_MODEL'
  | 'IS_GOOGLE_MODEL'
  | 'WORKFLOW_AGENTS'
  | 'TOOL_USE_AGENTS'
  | 'CWD'
  | 'DEFAULT_BIB_PATH'
  | 'BUILTIN_WORKFLOW_DIR'
  | 'BUILTIN_TOOLUSE_DIR'
  | 'CUSTOM_AGENTS_DIR'
  | 'AGENT_DOCS_DIR'
> {
  // Build agent lists for template use. Tool-use agents append their tools.
  function formatAgentList(
    agents: Pick<AgentEntry, 'name' | 'description' | 'tools'>[],
    includeTools = false,
  ): string {
    return agents
      .map((a) => {
        const toolsStr =
          includeTools && a.tools?.length ? ` [${a.tools.join(', ')}]` : '';
        return `- ${a.name}: ${a.description || 'No description'}${toolsStr}`;
      })
      .join('\n');
  }

  function getPromptAgents(category: AgentCategory): AgentEntry[] {
    return resolveDelegationScopeAgents(
      options.delegationAgentScope ?? undefined,
      category,
    );
  }

  // Filter out the current agent so it doesn't see itself as a delegation target
  const selfName = agentConfig.agent;
  const workflowAgentsList = formatAgentList(
    getPromptAgents(AgentCategory.Workflow).filter(
      (agent) => agent.name !== selfName,
    ),
  );
  const toolUseAgentsList = formatAgentList(
    getPromptAgents(AgentCategory.ToolUse).filter(
      (agent) => agent.name !== selfName,
    ),
    true,
  );

  // Get default bib path from settings (empty string if not configured)
  const defaultBibPath = getConfig<string>('texra.bib.defaultPath', '');

  return {
    MODEL: agentConfig.model,
    INSTRUCTION: agentConfig.instruction,
    IS_OPENAI_MODEL: providerFlags.isOpenai,
    IS_ANTHROPIC_MODEL: providerFlags.isAnthropic,
    IS_GOOGLE_MODEL: providerFlags.isGoogle,
    WORKFLOW_AGENTS: workflowAgentsList,
    TOOL_USE_AGENTS: toolUseAgentsList,
    CWD: options.workspacePath ?? WorkspaceFS.getPath() ?? '.',
    DEFAULT_BIB_PATH: defaultBibPath,
    ...getAgentDirectoryVars(),
  };
}

/**
 * Inject the absolute paths of registered agent directories as template
 * variables so agents (notably `creator`) can reference the real paths in
 * their system prompts. Reads from the external-roots registry populated at
 * activation — keyed off the stable `kind` field so renaming a user-visible
 * label cannot break prompt rendering. Absent roots render as empty strings
 * (e.g. in tests that don't run activation).
 */
function getAgentDirectoryVars(): Pick<
  KnownUserVars,
  | 'BUILTIN_WORKFLOW_DIR'
  | 'BUILTIN_TOOLUSE_DIR'
  | 'CUSTOM_AGENTS_DIR'
  | 'AGENT_DOCS_DIR'
> {
  const KIND_TO_VAR: Record<ExternalRootKind, string> = {
    builtInWorkflow: 'BUILTIN_WORKFLOW_DIR',
    builtInToolUse: 'BUILTIN_TOOLUSE_DIR',
    custom: 'CUSTOM_AGENTS_DIR',
    agentDocs: 'AGENT_DOCS_DIR',
  };
  const vars: Record<string, string> = {
    BUILTIN_WORKFLOW_DIR: '',
    BUILTIN_TOOLUSE_DIR: '',
    CUSTOM_AGENTS_DIR: '',
    AGENT_DOCS_DIR: '',
  };
  for (const root of listExternalRoots()) {
    vars[KIND_TO_VAR[root.kind]] = root.absolutePath;
  }
  // Loop writes computed keys from KIND_TO_VAR's values, which TS can't
  // verify incrementally match the four literal keys seeded above.
  return vars as Pick<
    KnownUserVars,
    | 'BUILTIN_WORKFLOW_DIR'
    | 'BUILTIN_TOOLUSE_DIR'
    | 'CUSTOM_AGENTS_DIR'
    | 'AGENT_DOCS_DIR'
  >;
}

// Maps a template prefix to its canonical file-list field, via typed
// accessors rather than a `keyof AgentConfig` lookup table — that would need
// an `as string[]`/`as string | null` cast at the read site to recover the
// per-field type a bare key name can't express.
type FileCategoryConfig = {
  readonly getMultiple: (config: AgentConfig) => string[];
  readonly getSingle?: (config: AgentConfig) => string | null;
};

const FILE_CATEGORIES: Record<string, FileCategoryConfig> = {
  INPUT: { getMultiple: (config) => config.inputFiles },
  CONTEXT: { getMultiple: (config) => config.contextFiles },
  MEDIA: { getMultiple: (config) => config.mediaFiles },
  EDITED: {
    getMultiple: (config) => config.editedFiles,
    getSingle: (config) => config.editedFile,
  },
};

/** Get the multi-list for a category (filtering empties) */
function getCategoryFiles(config: AgentConfig, category: string): string[] {
  const cat = FILE_CATEGORIES[category];
  if (!cat) return [];
  const list = cat.getMultiple(config);
  const single = cat.getSingle ? cat.getSingle(config) : null;
  return unique([single, ...list].filter(isNonEmptyString));
}

/** Categories used for building file vars (excludes MEDIA which is display-only) */
const FILE_VAR_CATEGORIES = ['INPUT', 'CONTEXT', 'EDITED'];

type FileCategoryVarKeys =
  | 'INPUT_FILE'
  | 'INPUT_CONTENT'
  | 'INPUT_FILES'
  | 'ALL_INPUTS'
  | 'LIST_OF_ALL_INPUTS'
  | 'CONTEXT_FILE'
  | 'CONTEXT_CONTENT'
  | 'CONTEXT_FILES'
  | 'ALL_CONTEXTS'
  | 'LIST_OF_ALL_CONTEXTS'
  | 'EDITED_FILE'
  | 'EDITED_CONTENT'
  | 'EDITED_FILES'
  | 'ALL_EDITEDS'
  | 'LIST_OF_ALL_EDITEDS'
  | 'MEDIA_FILE'
  | 'MEDIA_CONTENT';

async function getFileVars(
  agentConfig: AgentConfig,
  agentSetting: AgentSetting,
  logger: AgentTrace,
): Promise<Pick<KnownUserVars, FileCategoryVarKeys>> {
  // Keys are computed per FILE_VAR_CATEGORIES entry (`${prefix}_FILE`, etc.),
  // which TS can't verify incrementally match FileCategoryVarKeys — see the
  // single contained cast at the return below.
  const userVars: Record<string, unknown> = {};

  const contextFiles = getCategoryFiles(agentConfig, 'CONTEXT');

  // Log file categories being loaded (skip for tool-use agents).
  // Media files are excluded: they have no user vars (display-only in Init)
  // and are already logged with full load results by MediaExtractionNode in r0.
  if (agentSetting.agentCategory !== AgentCategory.ToolUse) {
    await logFileCategoriesWithExistence(logger, [
      ['Input Files', getCategoryFiles(agentConfig, 'INPUT')],
      ['Context Files', contextFiles],
    ]);
  }

  for (const prefix of FILE_VAR_CATEGORIES) {
    const allFiles = getCategoryFiles(agentConfig, prefix);
    const fileContent =
      allFiles.length > 0
        ? await getXmlFormatFromReadableFiles(allFiles)
        : { xml: null, readableFiles: [] };
    const readableFiles = fileContent.readableFiles;
    const primaryFile = readableFiles[0];

    const loaded =
      primaryFile != null &&
      (await setVarFromFile(primaryFile, prefix, userVars));
    if (!loaded) {
      userVars[`${prefix}_FILE`] = null;
      userVars[`${prefix}_CONTENT`] = null;
    }

    userVars[`ALL_${prefix}S`] = fileContent.xml;
    userVars[`${prefix}_FILES`] = readableFiles.map((file) =>
      getPromptFileName(file),
    );
    userVars[`LIST_OF_ALL_${prefix}S`] = getListOfFiles(readableFiles);
  }

  const mediaFiles = getCategoryFiles(agentConfig, 'MEDIA');
  userVars.MEDIA_FILE = mediaFiles[0] ?? null;
  userVars.MEDIA_CONTENT = null;

  return userVars as Pick<KnownUserVars, FileCategoryVarKeys>;
}

/**
 * Log file categories with existence checking.
 * Each category is logged separately with a VS Code native file list message.
 * Uses tuple array for explicit ordering guarantee.
 *
 * Processes all categories in parallel for better performance, but logs
 * them sequentially to preserve the expected UI display order.
 */
async function logFileCategoriesWithExistence(
  logger: AgentTrace,
  categories: Array<[category: string, files: string[]]>,
): Promise<void> {
  // Process all categories in parallel for better performance
  const results = await Promise.all(
    categories.map(async ([category, files]) => {
      if (files.length === 0) {
        return { category, entries: [] };
      }

      // Explicit type annotation prevents type widening if WorkspaceFS.exists changes
      const entries: Array<{ path: string; ok: boolean }> = await Promise.all(
        files.map(async (filePath) => {
          try {
            return { path: filePath, ok: await WorkspaceFS.exists(filePath) };
          } catch (_err) {
            // Treat permission/access errors as non-existent
            return { path: filePath, ok: false };
          }
        }),
      );

      return { category, entries };
    }),
  );

  // Log sequentially to preserve UI display order
  for (const { category, entries } of results) {
    logFileCategory(logger, category, entries);
  }
}

/**
 * Load the files an agent bundles next to its YAML. Paths are resolved against
 * the agent's directory; an absolute path is used as written.
 */
async function getRequiredFileVars(
  agentSetting: AgentSetting,
  agentPath: string,
): Promise<FileVarsResult> {
  const vars: Record<string, string> = {};
  const files: LoadedFileEntry[] = [];

  for (const [varName, filePath] of Object.entries(
    agentSetting.requiredFilesInternal,
  )) {
    if (!filePath) continue;

    const fullPath = path.resolve(agentPath, filePath);
    const ok = await setVarFromFile(fullPath, varName, vars, true);
    files.push({
      path: fullPath,
      ok,
      varName,
      source: 'requiredFilesInternal',
      internal: true,
    });
  }
  return { vars, files };
}

/**
 * Load attached memory files and format them as an XML block for prompt injection.
 * Memory paths are display paths (e.g. /memories/conventions.md).
 * Returns null if no memories are attached.
 */
async function getAttachedMemories(
  memoryPaths: string[],
): Promise<AttachedMemoriesResult> {
  if (memoryPaths.length === 0) return { xml: null, misses: [] };

  const results = await Promise.all(
    memoryPaths.map(async (displayPath) => {
      try {
        const storagePath = displayToStoragePath(displayPath);
        const raw = await StorageFS.read(storagePath);
        // Strip frontmatter metadata — only inject the user-visible content
        const { content } = parseFrontmatter(raw);
        const trimmed = content.trim();
        if (trimmed) {
          return {
            xml: `<memory name="${displayPath}">\n${trimmed}\n</memory>`,
            miss: null,
          };
        }
      } catch (error) {
        return {
          xml: null,
          miss: { path: displayPath, reason: toErrorMessage(error) },
        };
      }
      return { xml: null, miss: null };
    }),
  );

  const parts = results.map((result) => result.xml).filter(filterNotNull);
  const misses = results.map((result) => result.miss).filter(filterNotNull);
  return {
    xml:
      parts.length > 0
        ? `<attached_memories>\n${parts.join('\n')}\n</attached_memories>`
        : null,
    misses,
  };
}

export function resolveOutputFiles(
  agentConfig: AgentConfig,
  agentSetting: AgentSetting,
): Pick<KnownUserVars, 'OUTPUT_FILES'> {
  const userVars: Pick<KnownUserVars, 'OUTPUT_FILES'> = {};
  const explicitOutputFiles = (agentConfig.outputFiles ?? []).filter(Boolean);
  const defaultOutputFiles = (agentSetting.defaultOutputFiles ?? []).filter(
    Boolean,
  );
  const inputFiles = (agentConfig.inputFiles ?? []).filter(Boolean);
  const explicitFilesAreSubsetOfInputs =
    explicitOutputFiles.length > 0 &&
    explicitOutputFiles.every((file) => inputFiles.includes(file));
  // An empty defaultOutputFiles is already `[]`, so this single ternary covers
  // the "no usable outputs" case without a nested fallback branch.
  const useExplicit =
    explicitOutputFiles.length > 0 && !explicitFilesAreSubsetOfInputs;
  const outputFiles = useExplicit ? explicitOutputFiles : defaultOutputFiles;

  agentConfig.outputFiles = outputFiles;
  if (outputFiles.length > 0) {
    userVars.OUTPUT_FILES = outputFiles;
  }
  return userVars;
}

type ToolFlagsKeys =
  | 'AUTO_EXTRACT_FIGURE'
  | 'AUTO_EXTRACT_TIKZ_FIGURE'
  | 'INCLUDE_TEX_COUNT'
  | 'PRINT_INPUT_PROMPT'
  | 'AUTO_COMPILE_INPUT_PDF'
  | 'CODEX_GUIDANCE'
  | 'CLAUDE_CODE_GUIDANCE'
  | 'ROUNDS';

export function getToolFlags(
  agentConfig: AgentConfig,
  agentSetting: AgentSetting,
  agentPrompt: AgentPrompt,
): Pick<KnownUserVars, ToolFlagsKeys> {
  const flags: Pick<KnownUserVars, ToolFlagsKeys> = {
    AUTO_EXTRACT_FIGURE: agentConfig.toolConfig.autoExtractFigure,
    AUTO_EXTRACT_TIKZ_FIGURE: agentConfig.toolConfig.autoExtractTikzFigure,
    INCLUDE_TEX_COUNT: agentConfig.toolConfig.attachTeXCount,
    PRINT_INPUT_PROMPT: shouldSaveModelIO(),
    AUTO_COMPILE_INPUT_PDF: agentConfig.toolConfig.autoCompileInputPdf,
    // Kept to ~2 sentences: the codex/claude_code tool descriptions already
    // document the async execution-ID/thread mechanics; this only adds
    // when-to-choose guidance.
    CODEX_GUIDANCE: agentSetting.tools.some((t) => t.name === 'codex')
      ? 'Choose codex for coding tasks that benefit from a separate OpenAI agent — it runs in its own sandbox with independent tool use, async and multi-turn like delegate_agent. ' +
        'When multiple codex agents must edit the same files, or to isolate experimental changes, use a git worktree (`git worktree add ../worktree-name branch-name`) and pass its path as working_directory.'
      : '',
    CLAUDE_CODE_GUIDANCE: agentSetting.tools.some(
      (t) => t.name === 'claude_code',
    )
      ? 'Choose claude_code for coding tasks that benefit from a separate Anthropic Claude Code agent — it runs in its own workspace with independent file editing, search, and shell access, async and multi-turn like delegate_agent. ' +
        'codex and claude_code are both independent sandboxed coders distinct from the in-process delegate_agent specialists; prefer whichever vendor fits the task, and for parallel or isolated edits run them against a git worktree.'
      : '',
  };

  // Only compute ROUNDS for workflow agents, not tool-use agents
  if (agentSetting.agentCategory !== AgentCategory.ToolUse) {
    const { userRequest } = agentPrompt;
    let requestCount = 0;
    if (Array.isArray(userRequest)) {
      requestCount = userRequest.length;
    } else if (userRequest) {
      requestCount = 1;
    }
    const configuredRounds =
      'rounds' in agentSetting ? agentSetting.rounds : undefined;
    flags.ROUNDS = Math.max(configuredRounds ?? 2, requestCount);
  }

  return flags;
}
