/**
 * Shared utilities for file content preparation in model handlers.
 * Consolidates duplicated patterns across Anthropic, OpenAI, and Google handlers.
 */

// Local imports
import { type AgentTrace } from '@agent/trace';
import type { AgentWorkspaceState } from '@agent/core/state/AgentWorkspaceState';
import type { ResponseTextPostProcessor } from '@agent/runtime/responseTextProcessing';
import type { FileLocation } from '@shared/schemas';
import { AbsoluteFS } from '@utils/files';
import { extractScratchpad } from '@utils/text/xmlExtraction';

/**
 * Prepares existing output file content for model processing.
 *
 * This is the shared implementation for the pattern that appears in:
 * - modelHandlerAnthropic.ts (initializeOutputAndPrefill)
 * - modelHandlerOpenAI.ts (initializeOutputAndPrefill)
 * - modelHandlerGoogleGenAI.ts (initializeOutputAndPrefill)
 *
 * The function:
 * 1. Reads file content from the output location
 * 2. Cleans the content (applies replacement rules)
 * 3. Extracts and logs any scratchpad content
 * 4. Writes cleaned content back to the file
 * 5. Updates workspace state with the content
 *
 * @param outputLocation - Location of the output file
 * @param workspaceState - Workspace state to update with file content
 * @param logger - Logger for scratchpad output
 * @returns The prepared file content
 */
export async function prepareExistingOutputContent(
  outputLocation: FileLocation,
  workspaceState: AgentWorkspaceState,
  logger: AgentTrace,
  postProcessResponse: ResponseTextPostProcessor,
): Promise<{ fileContent: string }> {
  const raw = await AbsoluteFS.read(outputLocation.absolutePath);
  const content = postProcessResponse(raw);

  const scratchpad = await extractScratchpad(content, 'scratchpad');
  if (scratchpad) logger.domain({ key: 'scratchpad', text: scratchpad });

  await AbsoluteFS.write(outputLocation.absolutePath, content);

  // Update workspace state - critical for multi-round agents on resume
  // so that subsequent rounds have correct context
  workspaceState.assembly.accumulatedOutput = content;
  workspaceState.assembly.lastResponse = content;

  return { fileContent: content };
}
