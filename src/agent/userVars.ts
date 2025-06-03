// Utility functions for building user variables for prompts

import * as path from 'path';
import * as fs from 'fs';

import { AgentLogger } from '../logger/AgentLogger';
import { readFile } from '../utils/workspaceFileUtils';
import { setVarFromFile } from '../utils/fileVarUtils';
import { getXmlFormatFromFiles, getListOfFiles } from '../utils/promptUtils';
import { AgentConfig } from './AgentConfig';
import { AgentSetting } from './AgentDataclass';
import { ModelHandler } from './ModelHandler';

/**
 * Build all user variables needed for prompt rendering.
 */
export async function buildUserVars(
  agentConfig: AgentConfig,
  agentSetting: AgentSetting,
  agentPath: string,
  modelHandler: ModelHandler,
  logger: AgentLogger,
): Promise<Record<string, any>> {
  const userVars: Record<string, any> = {};
  Object.assign(userVars, getBasicVars(agentConfig, modelHandler));
  Object.assign(userVars, await getFileVars(agentConfig));
  Object.assign(
    userVars,
    await getRequiredFileVars(agentSetting, agentPath, logger),
  );
  Object.assign(
    userVars,
    await getPatternBasedFileVars(agentConfig, agentSetting, logger),
  );
  Object.assign(userVars, getOutputFilesOrder(agentConfig, agentSetting));
  Object.assign(userVars, getToolFlags(agentConfig, agentSetting));
  return userVars;
}

function getBasicVars(
  agentConfig: AgentConfig,
  modelHandler: ModelHandler,
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
    userVars[`${prefix}_CONTENT`] = filePath ? await readFile(filePath) : null;
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
): Promise<Record<string, any>> {
  const userVars: Record<string, any> = {};

  if (agentSetting.requiredFiles) {
    for (const [varName, filePath] of Object.entries(
      agentSetting.requiredFiles,
    )) {
      if (filePath) {
        await setVarFromFile(
          filePath,
          varName,
          userVars,
          logger,
          'requiredFiles',
        );
      }
    }
  }

  if (agentSetting.requiredFilesInternal) {
    for (const [varName, filePath] of Object.entries(
      agentSetting.requiredFilesInternal,
    )) {
      const fullPath = path.join(agentPath, filePath);
      await setVarFromFile(
        fullPath,
        varName,
        userVars,
        logger,
        'requiredFilesInternal',
        true,
      );
    }
  }

  return userVars;
}

async function getPatternBasedFileVars(
  agentConfig: AgentConfig,
  agentSetting: AgentSetting,
  logger: AgentLogger,
): Promise<Record<string, any>> {
  const userVars: Record<string, any> = {};

  if (agentSetting.filePatternsContain) {
    for (const patternConfig of agentSetting.filePatternsContain) {
      const pattern = patternConfig.pattern.toLowerCase();
      const varName = patternConfig.varName;
      const categories = patternConfig.categories;

      for (const category of categories) {
        const categoryValue = (agentConfig as any)[category];

        if (category.endsWith('File')) {
          if (categoryValue && categoryValue.toLowerCase().includes(pattern)) {
            await setVarFromFile(
              categoryValue,
              varName,
              userVars,
              logger,
              `Pattern '${pattern}'`,
            );
          }
        } else if (category.endsWith('Files')) {
          if (categoryValue) {
            for (const file of categoryValue) {
              if (file.toLowerCase().includes(pattern)) {
                const success = await setVarFromFile(
                  file,
                  varName,
                  userVars,
                  logger,
                  `Pattern '${pattern}'`,
                );
                if (success) {
                  break;
                }
              }
            }
          }
        }
      }
    }
  }

  return userVars;
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

function getToolFlags(
  agentConfig: AgentConfig,
  agentSetting: AgentSetting,
): Record<string, any> {
  return {
    ROUNDS: agentSetting.rounds ?? 2,
    AUTO_EXTRACT_FIGURE: agentConfig.toolConfig.autoExtractFigure,
    AUTO_EXTRACT_TIKZ_FIGURE: agentConfig.toolConfig.autoExtractTikzFigure,
    INCLUDE_TEX_COUNT: agentConfig.toolConfig.attachTeXCount,
    USE_PREFILL_FROM_INPUT: agentConfig.toolConfig.usePrefillFromInput,
    PRINT_INPUT_PROMPT: agentConfig.toolConfig.printInputPrompt,
    AUTO_COMPILE_INPUT_PDF: agentConfig.toolConfig.autoCompileInputPdf,
  };
}
