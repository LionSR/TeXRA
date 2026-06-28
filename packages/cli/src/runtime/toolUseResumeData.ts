import { type RuntimeAgentConfig } from '@agent/runtime/executionRequests';
import {
  readRuntimeToolUseResumeDataForConfig,
  type RuntimeToolUseResumeData,
} from '@agent/runtime/resumeCommands';
import { toErrorMessage } from '@common/errors';
import { createChannelTrace } from '@logger';
import type { ExecutionId } from '@shared/schemas';

const logger = createChannelTrace('CliToolUseResumeData');

export type CliToolUseResumeData = RuntimeToolUseResumeData;

async function readCliToolUseResumeData(
  id: ExecutionId,
  config: RuntimeAgentConfig,
): Promise<CliToolUseResumeData | null> {
  const resume = await readRuntimeToolUseResumeDataForConfig({
    executionId: id,
    config,
  });
  if (resume.status === 'failed') {
    throw new Error(resume.message, { cause: resume.error });
  }
  if (resume.status !== 'resumable') return null;
  return resume.data;
}

/**
 * Listing-safe variant. History listings enrich many entries at once, so a
 * single unreadable/corrupt flow record must not abort the whole listing:
 * degrade to `null` on retrieval failure.
 */
export async function readCliToolUseResumeDataForListing(
  id: ExecutionId,
  config: RuntimeAgentConfig,
): Promise<CliToolUseResumeData | null> {
  try {
    return await readCliToolUseResumeData(id, config);
  } catch (error) {
    logger.debug(
      `Ignoring unreadable resume data for history entry ${id}: ${toErrorMessage(error)}`,
    );
    return null;
  }
}
