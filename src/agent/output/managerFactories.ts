/**
 * Factory functions for output managers.
 *
 * Creates and configures managers for handling latexdiff operations
 * and XML output processing.
 */

import type { FileLocation } from '@shared/schemas';

import { LatexDiffManager } from './LatexDiffManager';
import { XmlOutputManager } from './XmlOutputManager';
import { getOutputFilesByRound, type OutputState, type OutputDependencies } from './outputState';

/** Creates a LatexDiffManager for handling latexdiff operations. */
export function createDiffManager(
  state: OutputState,
  deps: OutputDependencies,
): LatexDiffManager {
  return new LatexDiffManager(
    deps.agentSetting,
    () => getOutputFilesByRound(state),
    deps.baseFiles,
    deps.logger,
    deps.streamId,
    deps.fileService,
  );
}

/** Creates an XmlOutputManager for XML processing. */
export function createXmlManager(deps: OutputDependencies): XmlOutputManager {
  return new XmlOutputManager(
    deps.agentSetting,
    deps.agentConfig,
    deps.logger,
    deps.fileService,
  );
}

/** Ensures the XML output file has correct structure (closing tags, etc.). */
export async function ensureXmlStructure(
  xmlManager: XmlOutputManager,
  fileLocation: FileLocation,
  documentTag: string,
): Promise<void> {
  await xmlManager.ensureCorrectXmlStructure(fileLocation, documentTag);
}
