// Standard library imports
// Utility functions for building user variables for prompts
import * as path from 'path';

// Local imports - agent
import type { AgentConfig } from '../core/AgentConfig';
import { AgentSetting, AgentPrompt, AgentType } from '../core/AgentDataclass';
import type { IModelHandler } from '@agent/modelHandlers';
import {
  getXmlFormatFromFiles,
  getListOfFiles,
} from '@agent/utils/promptUtils';
import { setVarFromFile } from '@frontend/files/vars';

// Local imports
import { AgentLogger } from '@logger/AgentLogger';
import { MESSAGE_TYPES } from '@logger/messageTypes';
import { getConfig } from '@utils/config';
import { WorkspaceFS } from '@utils/files';

/**
 * Build all user variables needed for prompt rendering.
 */
type LoadedFileEntry = {
  path: string;
  ok: boolean;
  varName: string;
  source: string;
  internal?: boolean;
};

export async function buildUserVars(
  agentConfig: AgentConfig,
  agentSetting: AgentSetting,
  agentPrompt: AgentPrompt,
  agentPath: string,
  modelHandler: IModelHandler,
  logger: AgentLogger,
): Promise<Record<string, any>> {
  const userVars: Record<string, any> = {};
  const allLoadedFiles: LoadedFileEntry[] = [];

  Object.assign(userVars, getBasicVars(agentConfig, modelHandler));
  Object.assign(userVars, await getFileVars(agentConfig));

  const { vars: requiredVars, files: requiredFiles } =
    await getRequiredFileVars(agentSetting, agentPath, logger);
  Object.assign(userVars, requiredVars);
  allLoadedFiles.push(...requiredFiles);

  const { vars: patternVars, files: patternFiles } =
    await getPatternBasedFileVars(agentConfig, agentSetting, logger);
  Object.assign(userVars, patternVars);
  allLoadedFiles.push(...patternFiles);

  Object.assign(userVars, getOutputFilesOrder(agentConfig, agentSetting));
  Object.assign(userVars, getToolFlags(agentConfig, agentSetting, agentPrompt));

  // Emit aggregated file list if any files were loaded
  if (allLoadedFiles.length > 0) {
    logger.fileList(allLoadedFiles);
  }

  return userVars;
}

function getBasicVars(
  agentConfig: AgentConfig,
  modelHandler: IModelHandler,
): Record<string, any> {
  return {
    MODEL: agentConfig.model,
    INSTRUCTION: agentConfig.instruction,
    IS_OPENAI_MODEL: modelHandler.isOpenai,
    IS_ANTHROPIC_MODEL: modelHandler.isAnthropic,
    IS_GOOGLE_MODEL: modelHandler.isGoogle,
  };
}

async function getFileVars(
  agentConfig: AgentConfig,
): Promise<Record<string, any>> {
  const userVars: Record<string, any> = {};

  const allInputFiles = [
    agentConfig.inputFile,
    ...(agentConfig.inputFiles || []),
  ].filter(Boolean) as string[];
  const allReferenceFiles = [
    agentConfig.referenceFile,
    ...(agentConfig.referenceFiles || []),
  ].filter(Boolean) as string[];
  const allAuxiliaryFiles = [
    agentConfig.auxiliaryFile,
    ...(agentConfig.auxiliaryFiles || []),
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

  const collectionMappings: Record<string, [string[] | undefined, string[]]> = {
    INPUT: [
      agentConfig.inputFiles?.filter(Boolean) as string[] | undefined,
      allInputFiles,
    ],
    REFERENCE: [
      agentConfig.referenceFiles?.filter(Boolean) as string[] | undefined,
      allReferenceFiles,
    ],
    AUXILIARY: [
      agentConfig.auxiliaryFiles?.filter(Boolean) as string[] | undefined,
      allAuxiliaryFiles,
    ],
  };

  for (const [prefix, [additionalFiles, allFiles]] of Object.entries(
    collectionMappings,
  )) {
    const additionalXml = additionalFiles
      ? await getXmlFormatFromFiles(additionalFiles as string[])
      : null;
    const allXml = allFiles
      ? await getXmlFormatFromFiles(allFiles as string[])
      : null;

    userVars[`ADDITIONAL_${prefix}S`] = additionalXml;
    userVars[`ALL_${prefix}S`] = allXml;
    userVars[`LIST_OF_ALL_${prefix}S`] = getListOfFiles(allFiles as string[]);
  }

  return userVars;
}

async function getRequiredFileVars(
  agentSetting: AgentSetting,
  agentPath: string,
  logger: AgentLogger,
): Promise<{
  vars: Record<string, any>;
  files: LoadedFileEntry[];
}> {
  const userVars: Record<string, any> = {};
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
): Promise<{
  vars: Record<string, any>;
  files: LoadedFileEntry[];
}> {
  const userVars: Record<string, any> = {};
  const files: LoadedFileEntry[] = [];

  if (agentSetting.filePatternsContain) {
    for (const patternConfig of agentSetting.filePatternsContain) {
      const pattern = patternConfig.pattern.toLowerCase();
      const varName = patternConfig.varName;
      const categories = patternConfig.categories;

      for (const category of categories) {
        const categoryValue = (agentConfig as any)[category];

        if (category.endsWith('File')) {
          if (categoryValue && categoryValue.toLowerCase().includes(pattern)) {
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
          if (categoryValue) {
            for (const file of categoryValue) {
              if (file.toLowerCase().includes(pattern)) {
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
): Record<string, any> {
  const userVars: Record<string, any> = {};
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
): Record<string, any> {
  const shouldSaveInputPrompt = getConfig<boolean>(
    'debug.saveInputPrompt',
    false,
  );
  const flags: Record<string, any> = {
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
