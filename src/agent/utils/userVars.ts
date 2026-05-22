import * as path from 'path';

import { loadRuntimeSkillCatalog } from '@skills/runtimeSkills';
import type { AgentConfig } from '@agent/core/AgentConfig';
import { getVisibleAgents, type AgentEntry } from '@agent/index/agentRegistry';
import {
  AgentSetting,
  AgentPrompt,
  AgentCategory,
} from '@agent/core/AgentDataclass';
import { getConfig } from '@agent/core/config';
import { AgentLogger } from '@logger/AgentLogger';
import type { FileListEntry } from '@shared/schemas';
import { parseFrontmatter } from '@tools/memory/memoryMeta';
import { displayToStoragePath } from '@tools/memory/memoryUtils';
import { AbsoluteFS, WorkspaceFS } from '@utils/files';
import {
  getListOfFiles,
  getPromptFileName,
  getXmlFormatFromFiles,
} from '@utils/prompt';
import {
  listExternalRoots,
  type ExternalRootKind,
} from '@utils/files/externalRoots';
import { setVarFromFile } from '@utils/files/varsUtils';
import { StorageFS } from '@utils/files/storageFS';

/** Relative path from an agent directory to the shared LaTeX style rules file. */
const SHARED_LATEX_RULES_REL = '../shared/latex_style_rules.txt';

/**
 * User variables for prompt rendering
 */
export type UserVars = Record<string, unknown>;

/**
 * Information about a loaded file for prompt variable substitution.
 * Extends FileListEntry with required source and varName fields.
 * Compatible with FileListEntry (can be passed to AgentLogger.fileList).
 */
export type LoadedFileEntry = FileListEntry & {
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

/**
 * Result of loading file-based variables
 */
type FileVarsResult = {
  vars: UserVars;
  files: LoadedFileEntry[];
};

/**
 * Build all user variables needed for prompt rendering.
 *
 * @param workspacePath - Workspace root path override. Defaults to VS Code workspace.
 */
export async function buildUserVars(
  agentConfig: AgentConfig,
  agentSetting: AgentSetting,
  agentPrompt: AgentPrompt,
  agentPath: string,
  providerFlags: ModelProviderFlags,
  logger: AgentLogger,
  workspacePath?: string,
): Promise<UserVars> {
  const allLoadedFiles: LoadedFileEntry[] = [];

  // Parallelize independent I/O: required files, pattern files, rules, and memories
  const [
    { vars: requiredVars, files: requiredFiles },
    { vars: patternVars, files: patternFiles },
    latexStyleRules,
    attachedMemories,
    availableSkills,
  ] = await Promise.all([
    getRequiredFileVars(agentSetting, agentPath),
    getPatternBasedFileVars(agentConfig, agentSetting),
    // Load shared LaTeX style rules (best-effort; empty string if missing)
    AbsoluteFS.read(path.join(agentPath, SHARED_LATEX_RULES_REL)).catch(
      () => '',
    ),
    getAttachedMemories(agentConfig.memories),
    loadRuntimeSkillCatalog(logger),
  ]);
  allLoadedFiles.push(...requiredFiles);
  allLoadedFiles.push(...patternFiles);

  // Merge all variable sources using spread operator.
  // LATEX_STYLE_RULES is placed last to prevent silent overrides from spreads.
  const userVars: UserVars = {
    ...getBasicVars(agentConfig, providerFlags, workspacePath),
    ...(await getFileVars(agentConfig, agentSetting, logger)),
    ...requiredVars,
    ...patternVars,
    ...resolveOutputFiles(agentConfig, agentSetting),
    ...getToolFlags(agentConfig, agentSetting, agentPrompt),
    LATEX_STYLE_RULES: latexStyleRules,
    ATTACHED_MEMORIES: attachedMemories,
    AVAILABLE_SKILLS: availableSkills,
  };

  // Emit aggregated file list if any files were loaded
  if (allLoadedFiles.length > 0) {
    logger.fileList(allLoadedFiles);
  }

  return userVars;
}

function getBasicVars(
  agentConfig: AgentConfig,
  providerFlags: ModelProviderFlags,
  workspacePath?: string,
): UserVars {
  // Build agent lists for template use
  const formatAgentList = (agents: { name: string; description?: string }[]) =>
    agents
      .map((a) => `- ${a.name}: ${a.description || 'No description'}`)
      .join('\n');

  // Format tool-use agents with their available tools
  const formatToolUseAgentList = (
    agents: Pick<AgentEntry, 'name' | 'description' | 'tools'>[],
  ) =>
    agents
      .map((a) => {
        const toolsStr = a.tools?.length ? ` [${a.tools.join(', ')}]` : '';
        return `- ${a.name}: ${a.description || 'No description'}${toolsStr}`;
      })
      .join('\n');

  // Filter out the current agent so it doesn't see itself as a delegation target
  const selfName = agentConfig.agent;
  const workflowAgentsList = formatAgentList(
    getVisibleAgents('workflow').filter((a) => a.name !== selfName),
  );
  const toolUseAgentsList = formatToolUseAgentList(
    getVisibleAgents('toolUse').filter((a) => a.name !== selfName),
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
    CWD: workspacePath ?? WorkspaceFS.getPath() ?? '.',
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
function getAgentDirectoryVars(): UserVars {
  const KIND_TO_VAR: Record<ExternalRootKind, string> = {
    builtInWorkflow: 'BUILTIN_WORKFLOW_DIR',
    builtInToolUse: 'BUILTIN_TOOLUSE_DIR',
    custom: 'CUSTOM_AGENTS_DIR',
    agentDocs: 'AGENT_DOCS_DIR',
  };
  const vars: UserVars = {
    BUILTIN_WORKFLOW_DIR: '',
    BUILTIN_TOOLUSE_DIR: '',
    CUSTOM_AGENTS_DIR: '',
    AGENT_DOCS_DIR: '',
  };
  for (const root of listExternalRoots()) {
    vars[KIND_TO_VAR[root.kind]] = root.absolutePath;
  }
  return vars;
}

// Maps a template prefix to the canonical multi-list field. The
// single-keyed aliases (INPUT_FILE, CONTEXT_FILE, …, plus _CONTENT
// siblings) resolve to the head of this list for back-compat with
// custom user YAMLs.
type FileCategoryConfig = {
  multiple: keyof AgentConfig;
  single?: keyof AgentConfig;
};

const FILE_CATEGORIES: Record<string, FileCategoryConfig> = {
  INPUT: { multiple: 'inputFiles' },
  REFERENCE: { multiple: 'contextFiles' },
  MEDIA: { multiple: 'mediaFiles' },
  EDITED: { multiple: 'editedFiles', single: 'editedFile' },
};

/** Get the multi-list for a category (filtering empties) */
function getCategoryFiles(config: AgentConfig, category: string): string[] {
  const cat = FILE_CATEGORIES[category];
  if (!cat) return [];
  const list = (config[cat.multiple] as string[] | undefined) ?? [];
  const single = cat.single ? (config[cat.single] as string | null) : null;
  return [...new Set([single, ...list].filter((f): f is string => Boolean(f)))];
}

/** Categories used for building file vars (excludes MEDIA which is display-only) */
const FILE_VAR_CATEGORIES = ['INPUT', 'REFERENCE', 'EDITED'];

async function getFileVars(
  agentConfig: AgentConfig,
  agentSetting: AgentSetting,
  logger: AgentLogger,
): Promise<UserVars> {
  const userVars: UserVars = {};

  const contextFiles = getCategoryFiles(agentConfig, 'REFERENCE');

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
    const primaryFile = allFiles[0];

    // Aliases for custom YAMLs that still reference INPUT_FILE / INPUT_CONTENT.
    if (primaryFile) {
      await setVarFromFile(primaryFile, prefix, userVars);
    } else {
      userVars[`${prefix}_FILE`] = null;
      userVars[`${prefix}_CONTENT`] = null;
    }

    userVars[`ALL_${prefix}S`] =
      allFiles.length > 0 ? await getXmlFormatFromFiles(allFiles) : null;
    userVars[`${prefix}_FILES`] = allFiles.map((file) =>
      getPromptFileName(file),
    );
    userVars[`LIST_OF_ALL_${prefix}S`] = getListOfFiles(allFiles);
  }

  // ALL_CONTEXTS is the unified template var; the legacy ALL_REFERENCES
  // alias keeps populating it for back-compat with custom YAMLs.
  userVars.ALL_CONTEXTS = userVars.ALL_REFERENCES as string | null;
  userVars.LIST_OF_ALL_CONTEXTS = getListOfFiles(contextFiles);
  userVars.CONTEXT_FILE = userVars.REFERENCE_FILE;
  userVars.CONTEXT_CONTENT = userVars.REFERENCE_CONTENT;
  userVars.ALL_AUXILIARYS = userVars.ALL_CONTEXTS;
  userVars.LIST_OF_ALL_AUXILIARYS = userVars.LIST_OF_ALL_CONTEXTS;

  const mediaFiles = getCategoryFiles(agentConfig, 'MEDIA');
  userVars.MEDIA_FILE = mediaFiles[0] ?? null;
  userVars.MEDIA_CONTENT = null;

  return userVars;
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
  logger: AgentLogger,
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
    if (entries.length > 0) {
      logger.logFileCategory(category, entries);
    }
  }
}

async function processRequiredFileMap(
  fileMap: Record<string, string> | undefined,
  source: string,
  basePath?: string,
): Promise<FileVarsResult> {
  if (!fileMap) return { vars: {}, files: [] };

  const vars: UserVars = {};
  const files: LoadedFileEntry[] = [];

  for (const [varName, filePath] of Object.entries(fileMap)) {
    if (!filePath) continue;

    const fullPath = basePath ? path.join(basePath, filePath) : filePath;
    const ok = await setVarFromFile(fullPath, varName, vars, Boolean(basePath));
    files.push({
      path: fullPath,
      ok,
      varName,
      source,
      ...(basePath && { internal: true }),
    });
  }
  return { vars, files };
}

async function getRequiredFileVars(
  agentSetting: AgentSetting,
  agentPath: string,
): Promise<FileVarsResult> {
  // Process file maps in parallel - each returns its own vars object to avoid shared mutation
  const [required, internal] = await Promise.all([
    processRequiredFileMap(agentSetting.requiredFiles, 'requiredFiles'),
    processRequiredFileMap(
      agentSetting.requiredFilesInternal,
      'requiredFilesInternal',
      agentPath,
    ),
  ]);

  // Merge vars from both results
  return {
    vars: { ...required.vars, ...internal.vars },
    files: [...required.files, ...internal.files],
  };
}

async function getPatternBasedFileVars(
  agentConfig: AgentConfig,
  agentSetting: AgentSetting,
): Promise<FileVarsResult> {
  const userVars: UserVars = {};
  const files: LoadedFileEntry[] = [];

  if (!agentSetting.filePatternsContain) {
    return { vars: userVars, files };
  }

  for (const {
    pattern: rawPattern,
    varName,
    categories,
  } of agentSetting.filePatternsContain) {
    const pattern = rawPattern.toLowerCase();
    const source = `Pattern '${pattern}'`;

    // Helper to try setting a var from a file that matches the pattern
    async function trySetVar(filePath: string): Promise<boolean> {
      if (!filePath.toLowerCase().includes(pattern)) return false;
      const ok = await setVarFromFile(filePath, varName, userVars);
      files.push({ path: filePath, ok, varName, source });
      return ok;
    }

    // Check each category for matching files
    for (const category of categories) {
      const categoryValue = agentConfig[
        category as keyof AgentConfig
      ] as unknown;

      if (category.endsWith('File') && typeof categoryValue === 'string') {
        await trySetVar(categoryValue);
      } else if (category.endsWith('Files') && Array.isArray(categoryValue)) {
        // Try each file until one succeeds
        for (const file of categoryValue) {
          if (typeof file === 'string' && (await trySetVar(file))) break;
        }
      }
    }
  }

  return { vars: userVars, files };
}

/**
 * Load attached memory files and format them as an XML block for prompt injection.
 * Memory paths are display paths (e.g. /memories/conventions.md).
 * Returns null if no memories are attached.
 */
async function getAttachedMemories(
  memoryPaths: string[],
): Promise<string | null> {
  if (memoryPaths.length === 0) return null;

  const results = await Promise.all(
    memoryPaths.map(async (displayPath) => {
      try {
        const storagePath = displayToStoragePath(displayPath);
        const raw = await StorageFS.read(storagePath);
        // Strip frontmatter metadata — only inject the user-visible content
        const { content } = parseFrontmatter(raw);
        const trimmed = content.trim();
        if (trimmed) {
          return `<memory name="${displayPath}">\n${trimmed}\n</memory>`;
        }
      } catch {
        // Skip memories that can't be read (deleted between delegation and execution)
      }
      return null;
    }),
  );

  const parts = results.filter((p): p is string => p !== null);
  if (parts.length === 0) return null;
  return `<attached_memories>\n${parts.join('\n')}\n</attached_memories>`;
}

export function resolveOutputFiles(
  agentConfig: AgentConfig,
  agentSetting: AgentSetting,
): UserVars {
  const userVars: UserVars = {};
  const explicitOutputFiles = (agentConfig.outputFiles ?? []).filter(Boolean);
  const defaultOutputFiles = (agentSetting.defaultOutputFiles ?? []).filter(
    Boolean,
  );
  const inputFiles = (agentConfig.inputFiles ?? []).filter(Boolean);
  const explicitFilesAreSubsetOfInputs =
    explicitOutputFiles.length > 0 &&
    explicitOutputFiles.every((file) => inputFiles.includes(file));
  const outputFiles =
    !explicitFilesAreSubsetOfInputs && explicitOutputFiles.length > 0
      ? explicitOutputFiles
      : defaultOutputFiles.length > 0
        ? defaultOutputFiles
        : [];

  agentConfig.outputFiles = outputFiles;
  if (outputFiles.length > 0) {
    userVars.OUTPUT_FILES = outputFiles;
  }
  return userVars;
}

export function getToolFlags(
  agentConfig: AgentConfig,
  agentSetting: AgentSetting,
  agentPrompt: AgentPrompt,
): UserVars {
  const flags: UserVars = {
    AUTO_EXTRACT_FIGURE: agentConfig.toolConfig.autoExtractFigure,
    AUTO_EXTRACT_TIKZ_FIGURE: agentConfig.toolConfig.autoExtractTikzFigure,
    INCLUDE_TEX_COUNT: agentConfig.toolConfig.attachTeXCount,
    PRINT_INPUT_PROMPT: getConfig<boolean>(
      'texra.debug.saveInputPrompt',
      false,
    ),
    AUTO_COMPILE_INPUT_PDF: agentConfig.toolConfig.autoCompileInputPdf,
    CODEX_GUIDANCE: agentSetting.tools.some((t) => t.name === 'codex')
      ? 'Choose codex for coding tasks that benefit from a separate OpenAI agent — it runs in its own sandbox with independent tool use. ' +
        'Codex is async and multi-turn, mirroring delegate_agent: each call returns an execution ID, and results arrive as follow-up messages that include a thread_id. ' +
        'Pass that thread_id back on a later codex call to send a follow-up instruction to the same session — the agent retains full history and file context. ' +
        "If the thread is still processing, the follow-up waits in that session's queue. " +
        'When multiple codex agents need to edit the same files, or when you want to isolate experimental changes, ' +
        'use a git worktree (`git worktree add ../worktree-name branch-name`) and pass its path as working_directory.'
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
