import type { TaskState } from '@agent/core/execution/TaskState';
import { getSdkErrorMessage } from '@common/errors';
import * as logger from '@logger/logUtils';
import { isNonEmptyString } from '@utils/core';
import { extractTextFromTag } from '@utils/text/xmlUtils';

import { createHelperModelKit } from './helperModel';
import { initializePolishModel, renderPolishPrompt } from './polishModel';

const CHANNEL = 'TextPolishCommands';

export interface RuntimeTextPolishContext {
  agent?: string;
  inputFiles?: string[];
  contextFiles?: string[];
  mediaFiles?: string[];
  outputFiles?: string[];
}

export interface RuntimeTextPolishRequest {
  readonly text: string;
  readonly fileContext?: RuntimeTextPolishContext;
}

export interface RuntimeTextPolishInitialization {
  readonly promptTemplatePath: string;
}

export type RuntimeTextPolishResult =
  | {
      readonly success: true;
      readonly text: string;
    }
  | {
      readonly success: false;
      readonly text: string;
      readonly error?: string;
    };

export function buildRuntimeTextPolishContextFromTaskState(
  taskState: TaskState,
): RuntimeTextPolishContext {
  const { agentConfig } = taskState;
  const context: RuntimeTextPolishContext = {};

  if (agentConfig.agent) {
    context.agent = agentConfig.agent;
  }

  const arrayFields = [
    'inputFiles',
    'contextFiles',
    'mediaFiles',
    'outputFiles',
  ] as const;
  for (const field of arrayFields) {
    if (agentConfig[field].length > 0) {
      context[field] = agentConfig[field];
    }
  }

  return context;
}

export function initializeRuntimeTextPolish({
  promptTemplatePath,
}: RuntimeTextPolishInitialization): void {
  initializePolishModel(promptTemplatePath);
}

function formatFileContext(ctx: RuntimeTextPolishContext): string {
  const lines: string[] = ['Current context:'];
  if (ctx.agent) lines.push(`Agent: ${ctx.agent}`);

  const fileEntries: string[] = [];

  const fileGroups: Array<[string, string[] | undefined]> = [
    ['Input Files', ctx.inputFiles],
    ['Context Files', ctx.contextFiles],
    ['Media Files', ctx.mediaFiles],
    ['Output Files', ctx.outputFiles],
  ];
  for (const [label, files] of fileGroups) {
    if (files?.length) fileEntries.push(`${label}: ${files.join(', ')}`);
  }

  if (fileEntries.length > 0) {
    lines.push('', 'Files in the task:', ...fileEntries);
  }

  return `${lines.join('\n')}\n`;
}

export async function requestRuntimeTextPolish({
  text,
  fileContext,
}: RuntimeTextPolishRequest): Promise<RuntimeTextPolishResult> {
  try {
    const fileContextString = fileContext ? formatFileContext(fileContext) : '';
    const prompt = await renderPolishPrompt(fileContextString, text);

    const helperResult = await createHelperModelKit();
    if (!helperResult.kit) {
      throw new Error(helperResult.reason);
    }
    const { handler, client } = helperResult.kit;
    const messages = await handler.initializeMessages('', prompt);
    const result = await handler.createResponse({
      client,
      messages,
      temperature: 0,
    });
    const { text: responseText } = handler.extractResponse(result.response, '');
    if (!isNonEmptyString(responseText)) {
      throw new Error('Model returned no text.');
    }

    const corrected = extractTextFromTag(responseText, 'corrected_text');
    if (!corrected) {
      logger.warn(
        CHANNEL,
        'Model did not wrap response in <corrected_text> tags; using raw response',
      );
    }
    return { success: true, text: (corrected ?? responseText).trim() };
  } catch (error) {
    const message = getSdkErrorMessage(error);
    logger.error(CHANNEL, `Error polishing text: ${message}`);
    return { success: false, text, error: message };
  }
}
