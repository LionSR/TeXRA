// Utility functions for building user variables for prompts
import * as path from 'path';

// Local imports - agent
import type { AgentConfig } from '@agent/core/AgentConfig';
import {
  getVisibleWorkflowAgents,
  getVisibleToolUseAgents,
} from '@agent/index/agentRegistry';
// Internal imports
import {
  AgentSetting,
  AgentPrompt,
  AgentCategory,
} from '@agent/core/AgentDataclass';
import { AgentLogger } from '@logger/AgentLogger';
import type { FileListEntry } from '@shared/schemas';
import { getXmlFormatFromFiles, getListOfFiles } from '@utils/prompt';
import { getConfig } from '@utils/config';
import { WorkspaceFS } from '@utils/files';
import { setVarFromFile } from '@utils/files/varsUtils';

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
 */
export async function buildUserVars(
  agentConfig: AgentConfig,
  agentSetting: AgentSetting,
  agentPrompt: AgentPrompt,
  agentPath: string,
  providerFlags: ModelProviderFlags,
  logger: AgentLogger,
): Promise<UserVars> {
  const allLoadedFiles: LoadedFileEntry[] = [];

  const { vars: requiredVars, files: requiredFiles } =
    await getRequiredFileVars(agentSetting, agentPath, logger);
  allLoadedFiles.push(...requiredFiles);

  const { vars: patternVars, files: patternFiles } =
    await getPatternBasedFileVars(agentConfig, agentSetting, logger);
  allLoadedFiles.push(...patternFiles);

  // Merge all variable sources using spread operator
  const userVars: UserVars = {
    ...getBasicVars(agentConfig, providerFlags),
    ...(await getFileVars(agentConfig, agentSetting, logger)),
    ...requiredVars,
    ...patternVars,
    ...getOutputFilesOrder(agentConfig, agentSetting),
    ...getToolFlags(agentConfig, agentSetting, agentPrompt),
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
): UserVars {
  // Build agent lists for template use
  const formatAgentList = (agents: { name: string; description?: string }[]) =>
    agents
      .map((a) => `- ${a.name}: ${a.description || 'No description'}`)
      .join('\n');

  const workflowAgentsList = formatAgentList(getVisibleWorkflowAgents());
  const toolUseAgentsList = formatAgentList(getVisibleToolUseAgents());

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
    CWD: WorkspaceFS.getPath() ?? '.',
    DEFAULT_BIB_PATH: defaultBibPath,
  };
}

/**
 * File category configuration for consistent handling across the codebase.
 * Maps category name to { single, multiple } field accessors from AgentConfig.
 */
type FileCategoryConfig = {
  single: keyof AgentConfig;
  multiple: keyof AgentConfig;
};

const FILE_CATEGORIES: Record<string, FileCategoryConfig> = {
  INPUT: { single: 'inputFile', multiple: 'inputFiles' },
  REFERENCE: { single: 'referenceFile', multiple: 'referenceFiles' },
  AUXILIARY: { single: 'auxiliaryFile', multiple: 'auxiliaryFiles' },
  MEDIA: { single: 'mediaFile', multiple: 'mediaFiles' },
  EDITED: { single: 'editedFile', multiple: 'editedFiles' },
};

/** Combine a single file with an array, filtering out empty values */
function combineFiles(
  single: string | null | undefined,
  multiple: string[] | undefined,
): string[] {
  return [single, ...(multiple ?? [])].filter((f): f is string => Boolean(f));
}

/** Get combined files for a category from AgentConfig */
function getCategoryFiles(config: AgentConfig, category: string): string[] {
  const cat = FILE_CATEGORIES[category];
  if (!cat) return [];
  return combineFiles(
    config[cat.single] as string | null | undefined,
    config[cat.multiple] as string[] | undefined,
  );
}

async function getFileVars(
  agentConfig: AgentConfig,
  agentSetting: AgentSetting,
  logger: AgentLogger,
): Promise<UserVars> {
  const userVars: UserVars = {};

  const allInputFiles = getCategoryFiles(agentConfig, 'INPUT');
  const allReferenceFiles = getCategoryFiles(agentConfig, 'REFERENCE');
  const allAuxiliaryFiles = getCategoryFiles(agentConfig, 'AUXILIARY');
  const allMediaFiles = getCategoryFiles(agentConfig, 'MEDIA');

  // Log file categories being loaded (processed sequentially to preserve UI display order)
  // Skip for tool-use agents as they don't need this UI feedback
  if (agentSetting.agentCategory !== AgentCategory.ToolUse) {
    await logFileCategoriesWithExistence(logger, [
      ['Input Files', allInputFiles],
      ['Reference Files', allReferenceFiles],
      ['Auxiliary Files', allAuxiliaryFiles],
      ['Media Files', allMediaFiles],
    ]);
  }

  // Build single file vars for each category
  for (const prefix of ['INPUT', 'REFERENCE', 'AUXILIARY', 'EDITED']) {
    const cat = FILE_CATEGORIES[prefix];
    const filePath = agentConfig[cat.single] as string | null | undefined;
    userVars[`${prefix}_FILE`] = filePath ?? null;
    userVars[`${prefix}_CONTENT`] = filePath
      ? await WorkspaceFS.read(filePath)
      : null;
  }

  // Build collection vars for each category using the centralized config
  for (const prefix of ['INPUT', 'REFERENCE', 'AUXILIARY', 'EDITED']) {
    const cat = FILE_CATEGORIES[prefix];
    const rawAdditionalFiles =
      (agentConfig[cat.multiple] as string[] | undefined) ?? [];
    // Filter empty strings to prevent file read errors
    const additionalFiles = rawAdditionalFiles.filter(Boolean);
    const allFiles = getCategoryFiles(agentConfig, prefix);

    userVars[`ADDITIONAL_${prefix}S`] =
      additionalFiles.length > 0
        ? await getXmlFormatFromFiles(additionalFiles)
        : null;
    userVars[`ALL_${prefix}S`] =
      allFiles.length > 0 ? await getXmlFormatFromFiles(allFiles) : null;
    userVars[`LIST_OF_ALL_${prefix}S`] = getListOfFiles(allFiles);
  }

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
  logger: AgentLogger,
  source: string,
  basePath?: string,
): Promise<FileVarsResult> {
  if (!fileMap) return { vars: {}, files: [] };

  const vars: UserVars = {};
  const files: LoadedFileEntry[] = [];

  for (const [varName, filePath] of Object.entries(fileMap)) {
    if (!filePath) continue;

    const fullPath = basePath ? path.join(basePath, filePath) : filePath;
    const ok = await setVarFromFile(
      fullPath,
      varName,
      vars,
      logger,
      source,
      Boolean(basePath),
    );
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
  logger: AgentLogger,
): Promise<FileVarsResult> {
  // Process file maps in parallel - each returns its own vars object to avoid shared mutation
  const [required, internal] = await Promise.all([
    processRequiredFileMap(agentSetting.requiredFiles, logger, 'requiredFiles'),
    processRequiredFileMap(
      agentSetting.requiredFilesInternal,
      logger,
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
  logger: AgentLogger,
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
      const ok = await setVarFromFile(
        filePath,
        varName,
        userVars,
        logger,
        source,
      );
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

function getOutputFilesOrder(
  agentConfig: AgentConfig,
  agentSetting: AgentSetting,
): UserVars {
  const userVars: UserVars = {};
  if (
    Array.isArray(agentConfig.outputFiles) &&
    agentConfig.outputFiles.length > 0
  ) {
    userVars.OUTPUT_FILES_ORDER = agentConfig.outputFiles.join(', ');
  } else if (
    Array.isArray(agentSetting.defaultOutputFiles) &&
    agentSetting.defaultOutputFiles.length > 0
  ) {
    agentConfig.outputFiles = agentSetting.defaultOutputFiles;
    userVars.OUTPUT_FILES_ORDER = agentSetting.defaultOutputFiles.join(', ');
  }
  return userVars;
}

export function getToolFlags(
  agentConfig: AgentConfig,
  agentSetting: AgentSetting,
  agentPrompt: AgentPrompt,
): UserVars {
  const shouldSaveInputPrompt = getConfig<boolean>(
    'texra.debug.saveInputPrompt',
    false,
  );
  const flags: UserVars = {
    AUTO_EXTRACT_FIGURE: agentConfig.toolConfig.autoExtractFigure,
    AUTO_EXTRACT_TIKZ_FIGURE: agentConfig.toolConfig.autoExtractTikzFigure,
    INCLUDE_TEX_COUNT: agentConfig.toolConfig.attachTeXCount,
    PRINT_INPUT_PROMPT: shouldSaveInputPrompt,
    AUTO_COMPILE_INPUT_PDF: agentConfig.toolConfig.autoCompileInputPdf,
  };

  // Only compute ROUNDS for workflow agents, not tool-use agents
  if (agentSetting.agentCategory !== AgentCategory.ToolUse) {
    const { userRequest } = agentPrompt;
    let requestArray: string[];
    if (Array.isArray(userRequest)) {
      requestArray = userRequest;
    } else if (userRequest) {
      requestArray = [userRequest];
    } else {
      requestArray = [];
    }
    const configuredRounds =
      'rounds' in agentSetting ? agentSetting.rounds : undefined;
    flags.ROUNDS = Math.max(configuredRounds ?? 2, requestArray.length);
  }

  return flags;
}
