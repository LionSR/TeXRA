import { getSdkErrorMessage } from '@common/errors/sdkError/providerErrorFormat';
import { createLog } from '@logger/logUtils';
import { isNonEmptyString } from '@utils/core';

import { extractTextFromTag } from '@utils/text/xmlExtraction';
import { renderPolishPrompt } from './bundledPrompts';
import { createHelperModelKit, runHelperModelCompletion } from './helperModel';
import type { SessionHandle } from './SessionHandle';

const log = createLog('TextEnhancement');

// ── Types ────────────────────────────────────────────────────

export interface FileContext {
  agent?: string;
  inputFiles?: string[];
  contextFiles?: string[];
  mediaFiles?: string[];
  outputFiles?: string[];
}

// ── File context ─────────────────────────────────────────────

function formatFileContext(ctx: FileContext): string {
  const lines: string[] = ['Current context:'];
  if (ctx.agent) lines.push(`Agent: ${ctx.agent}`);

  const fileEntries: string[] = [];

  const arrays: [string, string[] | undefined][] = [
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
  session?: SessionHandle,
): Promise<{ success: boolean; text: string; error?: string }> {
  try {
    const fileContextString = fileContext ? formatFileContext(fileContext) : '';
    const prompt = await renderPolishPrompt(fileContextString, text);

    const helperResult = await createHelperModelKit(session);
    if (!helperResult.kit) {
      throw new Error(helperResult.reason);
    }
    const responseText = await runHelperModelCompletion(helperResult.kit, {
      userPrompt: prompt,
    });
    if (!isNonEmptyString(responseText)) {
      throw new Error('Model returned no text.');
    }

    const corrected = extractTextFromTag(responseText, 'corrected_text');
    if (!corrected) {
      log.warn(
        'Model did not wrap response in <corrected_text> tags; using raw response',
      );
    }
    return { success: true, text: (corrected ?? responseText).trim() };
  } catch (error) {
    const message = getSdkErrorMessage(error);
    log.error(`Error polishing text: ${message}`);
    return { success: false, text, error: message };
  }
}
