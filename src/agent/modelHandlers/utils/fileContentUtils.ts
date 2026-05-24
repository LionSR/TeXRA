/**
 * Shared utilities for file content preparation in model handlers.
 * Consolidates duplicated patterns across Anthropic, OpenAI, and Google handlers.
 */

// Local imports - agent workspace
import type { AgentTrace } from '@agent/trace';
import type { AgentWorkspaceState } from '@agent/core/AgentWorkspaceState';

// Local imports - replacement
import { cleanFileContent } from '@replacement/engine';

// Local imports - files
import { flexibleFS, type FileLocation } from '@utils/files';

// Local imports - xml
import { extractScratchpad } from '@utils/text/xmlUtils';

/**
 * Result of preparing file content for a model handler.
 */
export interface PreparedFileContent {
  /** The cleaned file content */
  fileContent: string;
  /** Whether a scratchpad was found and logged */
  hadScratchpad: boolean;
}

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
 * @returns The prepared file content and metadata
 */
export async function prepareExistingOutputContent(
  outputLocation: FileLocation,
  workspaceState: AgentWorkspaceState,
  logger: AgentTrace,
): Promise<PreparedFileContent> {
  // Read and clean the file content
  let content = await flexibleFS.read(outputLocation);
  content = cleanFileContent(content);

  // Extract any existing scratchpad content and log it
  const scratchpad = await extractScratchpad(content, 'scratchpad');
  if (scratchpad) {
    logger.domain({ key: 'scratchpad', text: scratchpad });
  }

  // Write cleaned content back to file
  await flexibleFS.write(outputLocation, content);

  // Update workspace state - critical for multi-round agents on resume
  // so that subsequent rounds have correct context
  workspaceState.assembly.accumulatedOutput = content;
  workspaceState.assembly.lastResponse = content;

  return {
    fileContent: content,
    hadScratchpad: Boolean(scratchpad),
  };
}
