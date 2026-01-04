// Utility functions for building user variables for prompts
import * as path from 'path';

// Local imports - agent
import type { AgentConfig } from '@agent/core/AgentConfig';
// Internal imports
import {
  AgentSetting,
  AgentPrompt,
  AgentCategory,
} from '@agent/core/AgentDataclass';
import { AgentLogger } from '@logger/AgentLogger';
import type { FileListEntry } from '@logger/messageTypes';
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
    const groupId = logger.withCurrentGroup((id) => id);
    logger.fileList(allLoadedFiles, groupId);
  }

  return userVars;
}

function getBasicVars(
  agentConfig: AgentConfig,
  providerFlags: ModelProviderFlags,
): UserVars {
  return {
    MODEL: agentConfig.model,
    INSTRUCTION: agentConfig.instruction,
    IS_OPENAI_MODEL: providerFlags.isOpenai,
    IS_ANTHROPIC_MODEL: providerFlags.isAnthropic,
    IS_GOOGLE_MODEL: providerFlags.isGoogle,
  };
}

async function getFileVars(
  agentConfig: AgentConfig,
  agentSetting: AgentSetting,
  logger: AgentLogger,
): Promise<UserVars> {
  const userVars: UserVars = {};

  const allInputFiles = [
    agentConfig.inputFile,
    ...agentConfig.inputFiles,
  ].filter(Boolean) as string[];
  const allReferenceFiles = [
    agentConfig.referenceFile,
    ...agentConfig.referenceFiles,
  ].filter(Boolean) as string[];
  const allAuxiliaryFiles = [
    agentConfig.auxiliaryFile,
    ...agentConfig.auxiliaryFiles,
  ].filter(Boolean) as string[];
  const allMediaFiles = [
    agentConfig.mediaFile,
    ...agentConfig.mediaFiles,
  ].filter(Boolean) as string[];

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

  const singleFileMappings = {
    INPUT: agentConfig.inputFile,
    REFERENCE: agentConfig.referenceFile,
    AUXILIARY: agentConfig.auxiliaryFile,
    EDITED: agentConfig.editedFile,
  } as Record<string, string | undefined>;

  for (const [prefix, filePath] of Object.entries(singleFileMappings)) {
    userVars[`${prefix}_FILE`] = filePath;
    userVars[`${prefix}_CONTENT`] = filePath
      ? await WorkspaceFS.read(filePath)
      : null;
  }

  const collectionMappings: Record<string, [string[], string[]]> = {
    INPUT: [agentConfig.inputFiles.filter(Boolean) as string[], allInputFiles],
    REFERENCE: [
      agentConfig.referenceFiles.filter(Boolean) as string[],
      allReferenceFiles,
    ],
    AUXILIARY: [
      agentConfig.auxiliaryFiles.filter(Boolean) as string[],
      allAuxiliaryFiles,
    ],
  };

  for (const [prefix, [additionalFiles, allFiles]] of Object.entries(
    collectionMappings,
  )) {
    const additionalXml =
      additionalFiles.length > 0
        ? await getXmlFormatFromFiles(additionalFiles)
        : null;
    const allXml =
      allFiles.length > 0 ? await getXmlFormatFromFiles(allFiles) : null;

    userVars[`ADDITIONAL_${prefix}S`] = additionalXml;
    userVars[`ALL_${prefix}S`] = allXml;
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
  const groupId = logger.withCurrentGroup((id) => id);
  for (const { category, entries } of results) {
    if (entries.length > 0) {
      logger.logFileCategory(category, entries, groupId);
    }
  }
}

async function getRequiredFileVars(
  agentSetting: AgentSetting,
  agentPath: string,
  logger: AgentLogger,
): Promise<FileVarsResult> {
  const userVars: UserVars = {};
  const files: LoadedFileEntry[] = [];

  if (agentSetting.requiredFiles) {
    for (const [varName, filePath] of Object.entries(
      agentSetting.requiredFiles,
    )) {
      if (filePath) {
        const ok = await setVarFromFile(
          filePath,
          varName,
          userVars,
          logger,
          'requiredFiles',
        );
        files.push({ path: filePath, ok, varName, source: 'requiredFiles' });
      }
    }
  }

  if (agentSetting.requiredFilesInternal) {
    for (const [varName, filePath] of Object.entries(
      agentSetting.requiredFilesInternal,
    )) {
      const fullPath = path.join(agentPath, filePath);
      const ok = await setVarFromFile(
        fullPath,
        varName,
        userVars,
        logger,
        'requiredFilesInternal',
        true,
      );
      files.push({
        path: fullPath,
        ok,
        varName,
        source: 'requiredFilesInternal',
        internal: true,
      });
    }
  }

  return { vars: userVars, files };
}

async function getPatternBasedFileVars(
  agentConfig: AgentConfig,
  agentSetting: AgentSetting,
  logger: AgentLogger,
): Promise<FileVarsResult> {
  const userVars: UserVars = {};
  const files: LoadedFileEntry[] = [];

  if (agentSetting.filePatternsContain) {
    for (const patternConfig of agentSetting.filePatternsContain) {
      const pattern = patternConfig.pattern.toLowerCase();
      const varName = patternConfig.varName;
      const categories = patternConfig.categories;

      for (const category of categories) {
        // Type-safe access to agent config properties
        const categoryValue = agentConfig[
          category as keyof AgentConfig
        ] as unknown;

        if (category.endsWith('File')) {
          if (
            categoryValue &&
            typeof categoryValue === 'string' &&
            categoryValue.toLowerCase().includes(pattern)
          ) {
            const ok = await setVarFromFile(
              categoryValue,
              varName,
              userVars,
              logger,
              `Pattern '${pattern}'`,
            );
            files.push({
              path: categoryValue,
              ok,
              varName,
              source: `Pattern '${pattern}'`,
            });
          }
        } else if (category.endsWith('Files')) {
          if (categoryValue && Array.isArray(categoryValue)) {
            for (const file of categoryValue) {
              if (
                typeof file === 'string' &&
                file.toLowerCase().includes(pattern)
              ) {
                const ok = await setVarFromFile(
                  file,
                  varName,
                  userVars,
                  logger,
                  `Pattern '${pattern}'`,
                );
                files.push({
                  path: file,
                  ok,
                  varName,
                  source: `Pattern '${pattern}'`,
                });
                if (ok) {
                  break;
                }
              }
            }
          }
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
    const requestArray = Array.isArray(agentPrompt.userRequest)
      ? agentPrompt.userRequest
      : agentPrompt.userRequest
        ? [agentPrompt.userRequest]
        : [];
    const configuredRounds =
      'rounds' in agentSetting ? agentSetting.rounds : undefined;
    flags.ROUNDS = Math.max(configuredRounds ?? 2, requestArray.length);
  }

  return flags;
}
