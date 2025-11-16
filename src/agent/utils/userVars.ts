// Utility functions for building user variables for prompts
import * as path from 'path';

// Local imports - agent
import type { IModelHandler } from '@agent/modelHandlers';
import type { AgentConfig } from '@agent/core/AgentConfig';
// Internal imports
import {
  AgentSetting,
  AgentPrompt,
  AgentType,
} from '@agent/core/AgentDataclass';
import {
  getXmlFormatFromFiles,
  getListOfFiles,
} from '@agent/utils/promptUtils';
import { setVarFromFile } from '@frontend/files/vars';
import { AgentLogger } from '@logger/AgentLogger';
import { MESSAGE_TYPES } from '@logger/messageTypes';
import { getConfig } from '@utils/config';
import { WorkspaceFS } from '@utils/files';

/**
 * User variables for prompt rendering
 */
export type UserVars = Record<string, unknown>;

/**
 * Information about a loaded file
 */
export type LoadedFileEntry = {
  path: string;
  ok: boolean;
  varName: string;
  source: string;
  internal?: boolean;
};

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
  modelHandler: IModelHandler,
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
    ...getBasicVars(agentConfig, modelHandler),
    ...(await getFileVars(agentConfig)),
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
  modelHandler: IModelHandler,
): UserVars {
  return {
    MODEL: agentConfig.model,
    INSTRUCTION: agentConfig.instruction,
    IS_OPENAI_MODEL: modelHandler.isOpenai,
    IS_ANTHROPIC_MODEL: modelHandler.isAnthropic,
    IS_GOOGLE_MODEL: modelHandler.isGoogle,
  };
}

async function getFileVars(agentConfig: AgentConfig): Promise<UserVars> {
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
  if (agentSetting.agentType !== AgentType.ToolUse) {
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
