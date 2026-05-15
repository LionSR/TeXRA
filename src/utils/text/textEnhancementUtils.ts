import { createHelperModelKit } from '@agent/runtime/helperModel';
import { renderPolishPrompt } from '@agent/runtime/polishModel';
import { toErrorMessage } from '@common/errors';
import * as logger from '@logger/logUtils';
import type { TaskState } from '@logger/TaskState';
import { isNonEmptyString } from '@utils/core';

import { extractTextFromTag } from './xmlUtils';

const CHANNEL = 'TextEnhancement';

// ── Types ────────────────────────────────────────────────────

export interface FileContext {
  agent?: string;
  inputFiles?: string[];
  contextFiles?: string[];
  mediaFiles?: string[];
  outputFiles?: string[];
}

// ── File context ─────────────────────────────────────────────

export function buildFileContextFromTaskState(
  taskState: TaskState,
): FileContext {
  const { agentConfig } = taskState;
  const context: FileContext = {};

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

function formatFileContext(ctx: FileContext): string {
  const lines: string[] = ['Current context:'];
  if (ctx.agent) lines.push(`Agent: ${ctx.agent}`);

  const fileEntries: string[] = [];

  const arrays: Array<[string, string[] | undefined]> = [
    ['Input Files', ctx.inputFiles],
    ['Context Files', ctx.contextFiles],
    ['Media Files', ctx.mediaFiles],
    ['Output Files', ctx.outputFiles],
  ];
  for (const [label, files] of arrays) {
    if (files?.length) fileEntries.push(`${label}: ${files.join(', ')}`);
  }

  if (fileEntries.length > 0) {
    lines.push('', 'Files in the task:', ...fileEntries);
  }

  return lines.join('\n') + '\n';
}

// ── Polishing ────────────────────────────────────────────────

export async function polishTextWithAI(
  text: string,
  fileContext?: FileContext,
): Promise<{ success: boolean; text: string; error?: string }> {
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
    logger.error(CHANNEL, `Error polishing text: ${toErrorMessage(error)}`);
    return { success: false, text, error: toErrorMessage(error) };
  }
}
