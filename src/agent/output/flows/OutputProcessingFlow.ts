/**
 * Output processing flow following pocketflow architecture.
 *
 * This flow provides a thin orchestration layer over OutputHandler,
 * delegating all actual processing to the battle-tested implementation.
 *
 * Single source of truth: OutputHandler.processOutputFiles()
 */

// Local imports - core flow primitives
import { Flow } from '@agent/node';

// Local imports - types
import type { OutputFileInfo } from '@agent/output/types';
import { createOutputProcessingShared } from './OutputProcessingTypes';
import {
  ProcessOutputNode,
  type OutputProcessingServices,
  type OutputProcessingParams,
} from './OutputProcessingNodes';
import type {
  OutputProcessingShared,
  OutputProcessingInput,
} from './OutputProcessingTypes';

// ============================================================================
// FLOW RESULT
// ============================================================================

/**
 * Result of output processing flow execution.
 */
export interface OutputProcessingResult {
  /** Whether processing completed successfully */
  success: boolean;
  /** Processed output files with metadata */
  files: OutputFileInfo[];
  /** Error encountered during processing (if any) */
  error: Error | null;
}

// ============================================================================
// FLOW FACTORY
// ============================================================================

/**
 * Creates an output processing flow.
 *
 * The flow delegates all processing to OutputHandler.processOutputFiles(),
 * following pocketflow's prep -> exec -> post pattern for clean orchestration.
 */
export function createOutputProcessingFlow(): Flow<
  OutputProcessingShared,
  OutputProcessingParams
> {
  const processNode = new ProcessOutputNode();
  return new Flow<OutputProcessingShared, OutputProcessingParams>(processNode);
}

// ============================================================================
// RUNNER FUNCTION
// ============================================================================

/**
 * Runs the output processing flow with the given input and services.
 *
 * This is the main entry point for output processing, providing a clean
 * interface that delegates to OutputHandler.
 *
 * @param input - Input configuration for processing
 * @param services - Required services (outputHandler, ensureXmlStructure)
 * @returns Processing result with files and status
 *
 * @example
 * ```typescript
 * const result = await runOutputProcessing(
 *   {
 *     outputLocation: outputFile,
 *     currRound: 0,
 *     baseFiles: this.baseFiles,
 *     agentSetting: this.agentSetting,
 *     agentConfig: this.agentConfig,
 *     endTurn: true,
 *     shouldValidateXml: true,
 *     documentTag: 'document',
 *   },
 *   {
 *     outputHandler: this.outputHandler,
 *     ensureXmlStructure: (loc, tag) =>
 *       this.outputHandler.xmlManager.ensureCorrectXmlStructure(loc, tag),
 *   }
 * );
 * ```
 */
export async function runOutputProcessing(
  input: OutputProcessingInput,
  services: OutputProcessingServices,
): Promise<OutputProcessingResult> {
  // Create the shared store
  const shared = createOutputProcessingShared(input);

  // Create and configure the flow
  const flow = createOutputProcessingFlow();
  flow.setParams({ services });

  // Run the flow
  await flow.run(shared);

  // Extract result from shared store
  return {
    success: shared.state.error === null,
    files: shared.state.processedFiles,
    error: shared.state.error,
  };
}

// ============================================================================
// RE-EXPORTS
// ============================================================================

export type { OutputProcessingServices, OutputProcessingParams };
export type { OutputProcessingInput, OutputProcessingShared };
