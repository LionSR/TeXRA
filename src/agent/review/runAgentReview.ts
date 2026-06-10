/**
 * Local agent review: one-shot LLM review of the working tree's diff
 * against the main branch.
 *
 * Orchestrates diff collection (`reviewDiff`), prompt building and response
 * parsing (`reviewIssues`), and the model call. Uses the configured helper
 * model unless the user pins a dedicated review model. Host-neutral — the
 * extension layer owns settings, diagnostics, and UI.
 */

// Standard library imports
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';

// Third-party imports
import { MODEL_CONFIGS } from 'llm-zoo';

// Local imports
import type { ModelHandler } from '@agent/modelHandlers/ModelHandler';
import { createHelperModelKit } from '@agent/runtime/helperModel';
import { createModelHandler } from '@agent/runtime/ModelFactory';
import { getSdkErrorMessage } from '@common/errors';
import * as logger from '@logger/logUtils';
import { getModelUnavailableReason } from '@model/computeModelOptions';

import { collectReviewDiff } from './reviewDiff';
import {
  buildReviewPrompts,
  normalizeReviewFilePath,
  parseReviewResponse,
  type ReviewApproach,
  type ReviewIssue,
} from './reviewIssues';

const CHANNEL = 'AgentReview';

/** Caps for the extra full-file context attached in thorough mode. */
const MAX_CONTEXT_FILES = 12;
const MAX_CONTEXT_FILE_CHARS = 24_000;
const MAX_CONTEXT_TOTAL_CHARS = 120_000;

export interface RunAgentReviewOptions {
  cwd: string;
  includeUntracked: boolean;
  includeSubmodules: boolean;
  approach: ReviewApproach;
  /** Model id to use instead of the helper model; falls back when unavailable. */
  modelOverride?: string;
  signal?: AbortSignal;
}

export type AgentReviewOutcome =
  | {
      status: 'ok';
      issues: ReviewIssue[];
      baseDescription: string;
      modelName: string;
      changedFileCount: number;
      truncated: boolean;
    }
  | { status: 'no-changes'; baseDescription: string }
  | { status: 'error'; reason: string };

interface ReviewModelKit {
  handler: ModelHandler;
  client: unknown;
  modelName: string;
}

/**
 * Resolve the model for the review call: the explicit override when it is
 * recognized and available, otherwise the shared helper model.
 */
async function createReviewModelKit(
  modelOverride: string | undefined,
): Promise<ReviewModelKit | { reason: string }> {
  if (modelOverride) {
    const reason = await getModelUnavailableReason(modelOverride);
    if (reason) {
      logger.warn(
        CHANNEL,
        `Review model "${modelOverride}" unavailable (${reason}); falling back to the helper model.`,
      );
    } else {
      const handler = await createModelHandler(MODEL_CONFIGS[modelOverride]);
      handler.setOutputStreaming(false);
      handler.setProgressViewEnabled(false);
      const client = await handler.getClient();
      return { handler, client, modelName: modelOverride };
    }
  }

  const helperResult = await createHelperModelKit();
  if (!helperResult.kit) return { reason: helperResult.reason };
  return helperResult.kit;
}

/** Read full contents of changed files for thorough mode, within caps. */
async function gatherFileContext(
  cwd: string,
  changedFiles: string[],
): Promise<string | undefined> {
  const sections: string[] = [];
  let total = 0;
  for (const file of changedFiles.slice(0, MAX_CONTEXT_FILES)) {
    let content: Buffer;
    try {
      content = await readFile(path.join(cwd, file));
    } catch {
      continue; // Deleted or unreadable; the diff already shows it.
    }
    if (content.subarray(0, 8000).includes(0)) continue; // Binary.
    let text = content.toString('utf8');
    if (text.length > MAX_CONTEXT_FILE_CHARS) {
      text = `${text.slice(0, MAX_CONTEXT_FILE_CHARS)}\n[... truncated]`;
    }
    if (total + text.length > MAX_CONTEXT_TOTAL_CHARS) break;
    total += text.length;
    sections.push(`<file path="${file}">\n${text}\n</file>`);
  }
  return sections.length > 0 ? sections.join('\n\n') : undefined;
}

/**
 * Run a local agent review of the working tree against the main branch.
 * Never throws; failures are reported through the `error` outcome.
 */
export async function runAgentReview(
  options: RunAgentReviewOptions,
): Promise<AgentReviewOutcome> {
  try {
    const collected = await collectReviewDiff({
      cwd: options.cwd,
      includeUntracked: options.includeUntracked,
      includeSubmodules: options.includeSubmodules,
    });
    if (!collected.ok) {
      return { status: 'error', reason: collected.reason };
    }
    const { diff, baseDescription, changedFiles, truncated } = collected.value;
    if (!diff) {
      return { status: 'no-changes', baseDescription };
    }

    const kit = await createReviewModelKit(options.modelOverride);
    if ('reason' in kit) {
      return { status: 'error', reason: kit.reason };
    }

    const extraContext =
      options.approach === 'thorough'
        ? await gatherFileContext(options.cwd, changedFiles)
        : undefined;
    const { systemPrompt, userPrompt } = buildReviewPrompts({
      baseDescription,
      changedFiles,
      diff,
      approach: options.approach,
      extraContext,
    });

    logger.info(
      CHANNEL,
      `Reviewing ${changedFiles.length} changed files against ${baseDescription} with ${kit.modelName} (${options.approach})`,
    );
    const messages = await kit.handler.initializeMessages(
      '',
      userPrompt,
      undefined,
      systemPrompt,
    );
    const result = await kit.handler.createResponse({
      client: kit.client,
      messages,
      temperature: 0,
      systemPrompt,
      signal: options.signal,
    });
    const { text } = kit.handler.extractResponse(result.response, '');

    const parsed = parseReviewResponse(text ?? '');
    // Anchor issues to files that are actually part of the change; a model
    // occasionally invents paths and a dangling diagnostic helps no one.
    // Prefix matches keep issues inside changed submodules, whose diff
    // entries name the submodule directory rather than the inner file.
    const knownFiles = new Set(changedFiles.map(normalizeReviewFilePath));
    const isKnown = (file: string): boolean =>
      knownFiles.has(file) ||
      [...knownFiles].some((known) => file.startsWith(`${known}/`));
    const issues = parsed.filter((issue) => isKnown(issue.file));
    if (issues.length < parsed.length) {
      logger.warn(
        CHANNEL,
        `Dropped ${parsed.length - issues.length} review issue(s) referencing files outside the change set.`,
      );
    }

    return {
      status: 'ok',
      issues,
      baseDescription,
      modelName: kit.modelName,
      changedFileCount: changedFiles.length,
      truncated,
    };
  } catch (err) {
    if (options.signal?.aborted) {
      return { status: 'error', reason: 'Review cancelled.' };
    }
    return { status: 'error', reason: getSdkErrorMessage(err) };
  }
}
