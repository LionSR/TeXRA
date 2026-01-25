// (none needed)

// Third-party imports
import * as vscode from 'vscode';

// Local imports - agent runtime
import { MODEL_CONFIGS } from 'llm-zoo';
import { createModelHandler } from '@agent/runtime/ModelFactory';
import type { ModelHandler } from '@agent/modelHandlers/ModelHandler';
import { getSdkErrorMessage } from '@common/errors';
import * as logger from '@logger/logUtils';
// Type imports
import type { TaskState } from '@logger/TaskState';

// Local imports - model configs
import { getConfig } from '@utils/config';
import { isNonEmptyString } from '@utils/core';

// Local file imports
import { extractTextFromTag } from './xmlUtils';

const CHANNEL = 'TextEnhancement';

const DEFAULT_POLISH_MODEL = 'sonnet45';

/**
 * Text Enhancement Utilities
 *
 * This module contains utilities for enhancing and polishing text content.
 * It can be extended with additional text processing functions in the future,
 * such as:
 * - Text summarization
 * - Format conversion (e.g., from plain text to LaTeX)
 * - Code formatting
 * - Text generation based on templates
 * - Text simplification or complexity adjustment
 */

/**
 * Interface for file context information
 */
export interface FileContext {
  agent?: string;
  inputFile?: string;
  inputFiles?: string[];
  referenceFile?: string;
  referenceFiles?: string[];
  auxiliaryFile?: string;
  auxiliaryFiles?: string[];
  mediaFile?: string;
  mediaFiles?: string[];
  outputFiles?: string[];
}

/**
 * Derive a FileContext from a stored task state.
 */
export function buildFileContextFromTaskState(
  taskState: TaskState,
): FileContext {
  const { agentConfig } = taskState;
  const context: FileContext = {};

  if (agentConfig.agent) {
    context.agent = agentConfig.agent;
  }
  if (isNonEmptyString(agentConfig.inputFile)) {
    context.inputFile = agentConfig.inputFile;
  }
  if (agentConfig.inputFiles.length > 0) {
    context.inputFiles = agentConfig.inputFiles;
  }
  if (isNonEmptyString(agentConfig.referenceFile)) {
    context.referenceFile = agentConfig.referenceFile;
  }
  if (agentConfig.referenceFiles.length > 0) {
    context.referenceFiles = agentConfig.referenceFiles;
  }
  if (isNonEmptyString(agentConfig.auxiliaryFile)) {
    context.auxiliaryFile = agentConfig.auxiliaryFile;
  }
  if (agentConfig.auxiliaryFiles.length > 0) {
    context.auxiliaryFiles = agentConfig.auxiliaryFiles;
  }
  if (isNonEmptyString(agentConfig.mediaFile)) {
    context.mediaFile = agentConfig.mediaFile;
  }
  if (agentConfig.mediaFiles.length > 0) {
    context.mediaFiles = agentConfig.mediaFiles;
  }
  if (agentConfig.outputFiles.length > 0) {
    context.outputFiles = agentConfig.outputFiles;
  }

  return context;
}

/**
 * Polishes instruction text using Claude AI model
 * Corrects spelling, grammar, and formatting for LaTeX, XML, and Markdown
 * Also corrects file references if fileContext is provided
 *
 * @param text The text to polish
 * @param fileContext Optional context about files being used in the task
 * @returns Promise with the polished text or error message
 */
export async function polishTextWithAI(
  text: string,
  fileContext?: FileContext,
): Promise<{ success: boolean; text: string; error?: string }> {
  try {
    const useCopilot = getConfig<boolean>('texra.model.useCopilot', false);

    // Build file context string if available
    let fileContextString = '';
    if (fileContext) {
      const lines: string[] = ['Current context:'];

      if (fileContext.agent) {
        lines.push(`Agent: ${fileContext.agent}`);
      }

      const fileEntries: Array<{ label: string; value: string }> = [];

      if (fileContext.inputFile) {
        fileEntries.push({ label: 'Input File', value: fileContext.inputFile });
      }
      if (fileContext.referenceFile) {
        fileEntries.push({
          label: 'Reference File',
          value: fileContext.referenceFile,
        });
      }
      if (fileContext.auxiliaryFile) {
        fileEntries.push({
          label: 'Auxiliary File',
          value: fileContext.auxiliaryFile,
        });
      }
      if (fileContext.mediaFile) {
        fileEntries.push({
          label: 'Figure File',
          value: fileContext.mediaFile,
        });
      }

      const arrays: Array<[string, string[] | undefined]> = [
        ['Input Files', fileContext.inputFiles],
        ['Reference Files', fileContext.referenceFiles],
        ['Auxiliary Files', fileContext.auxiliaryFiles],
        ['Media Files', fileContext.mediaFiles],
        ['Output Files', fileContext.outputFiles],
      ];

      for (const [label, files] of arrays) {
        if (files && files.length > 0) {
          fileEntries.push({ label, value: files.join(', ') });
        }
      }

      if (fileEntries.length > 0) {
        lines.push('', 'Files in the task:');
        for (const { label, value } of fileEntries) {
          lines.push(`${label}: ${value}`);
        }
      }

      fileContextString = lines.join('\n');
    }

    // Setup the prompt
    const prompt = `Please review the following instruction text and correct any spelling errors, typos, grammatical mistakes, or punctuation issues. Preserve the original meaning and tone without adding new content or changing the structure unless necessary for clarity.

${fileContextString ? fileContextString + '\n' : ''}This text will be used as an instruction for editing the files mentioned above. If the text contains references to these files, please ensure they are correctly spelled and match the exact filenames.

Also, please follow these specific formatting rules:
1. If you spot inline LaTeX formulas, ensure they are wrapped with $ symbols (e.g., $E=mc^2$)
2. If you spot XML tags, fix any unbalanced or unpaired tags
3. If you spot Markdown syntax (like headers, lists, emphasis, links), fix any incorrect syntax
4. If there are partial or ambiguous references to filenames from the context provided above, correct them to use the proper full filename

Return the corrected text wrapped in <corrected_text> XML tags.

Text to correct:
${text}`;

    let responseText = '';

    if (useCopilot) {
      const [model] = await vscode.lm.selectChatModels({
        vendor: 'copilot',
        family: 'gpt-4o',
      });
      if (!model) {
        return { success: false, text, error: 'No Copilot model available.' };
      }
      const response = await model.sendRequest([
        vscode.LanguageModelChatMessage.User(prompt),
      ]);
      for await (const chunk of response.text) {
        responseText += chunk;
      }
    } else {
      const configuredModel = getConfig<string>(
        'model.instructionPolishModel',
        DEFAULT_POLISH_MODEL,
      );
      const modelName = isNonEmptyString(configuredModel)
        ? configuredModel.trim()
        : DEFAULT_POLISH_MODEL;
      const modelConfig = MODEL_CONFIGS[modelName];

      if (!modelConfig) {
        return {
          success: false,
          text,
          error: `Unsupported instruction polishing model "${modelName}". Update texra.model.instructionPolishModel to match a short name from your TeXRA model list.`,
        };
      }

      let handler: ModelHandler;
      try {
        handler = createModelHandler(modelConfig);
      } catch (error) {
        logger.error(
          CHANNEL,
          `Failed to create model handler: ${getSdkErrorMessage(error)}`,
        );
        return {
          success: false,
          text,
          error:
            'Unable to initialize the instruction polishing model. Please verify your model settings.',
        };
      }

      handler.setOutputStreaming(false);
      handler.setProgressViewEnabled(false);

      let client: unknown;
      try {
        client = await handler.getClient();
      } catch (error) {
        logger.error(
          CHANNEL,
          `Failed to initialize model client: ${getSdkErrorMessage(error)}`,
        );
        return {
          success: false,
          text,
          error:
            'Unable to initialize the instruction polishing model. Please check your API key and network settings.',
        };
      }

      let messages;
      try {
        messages = await handler.initializeMessages('', prompt);
      } catch (error) {
        logger.error(
          CHANNEL,
          `Failed to prepare messages for polishing: ${getSdkErrorMessage(error)}`,
        );
        return {
          success: false,
          text,
          error:
            'Unable to prepare the polishing request for the selected model.',
        };
      }

      let response;
      try {
        response = await handler.createResponse({
          client,
          messages,
          temperature: 0,
        });
      } catch (error) {
        logger.error(
          CHANNEL,
          `Failed to generate polishing response: ${getSdkErrorMessage(error)}`,
        );
        return {
          success: false,
          text,
          error: 'The instruction polishing request failed. Please try again.',
        };
      }

      let extractedText: string;
      try {
        ({ text: extractedText } = handler.extractResponse(response, ''));
      } catch (error) {
        logger.error(
          CHANNEL,
          `Failed to parse polishing response: ${getSdkErrorMessage(error)}`,
        );
        return {
          success: false,
          text,
          error: 'The instruction polishing response could not be parsed.',
        };
      }

      if (!isNonEmptyString(extractedText)) {
        const warningMessage =
          'Instruction polishing model returned no plain text.';
        logger.warn(CHANNEL, warningMessage);
        return {
          success: false,
          text,
          error: warningMessage,
        };
      }

      responseText = extractedText;
    }

    // Extract the corrected text using the utility function
    const correctedText = extractTextFromTag(responseText, 'corrected_text');

    // Trim leading and trailing newlines from the text
    const trimmedText = correctedText
      ? correctedText.trim()
      : responseText.trim();

    return {
      success: true,
      text: trimmedText,
    };
  } catch (error) {
    logger.error(CHANNEL, `Error polishing text: ${getSdkErrorMessage(error)}`);
    return {
      success: false,
      text: text,
      error: `Error polishing text: ${error instanceof Error ? 'Text enhancement failed' : 'Unknown error'}`,
    };
  }
}
