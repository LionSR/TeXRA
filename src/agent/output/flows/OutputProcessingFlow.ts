/**
 * Output processing flow following pocketflow architecture.
 *
 * This flow orchestrates the output processing pipeline:
 * prepare → xmlValidation → processFiles → indentFiles → replaceInputs → finalize
 *
 * The flow uses action-based transitions to handle different processing paths:
 * - SKIP_VALIDATION: Skip XML validation for non-XML outputs
 * - SKIP_DIFF: Skip diff generation when turn hasn't ended
 * - ERROR: Handle processing errors
 */

// Local imports - core flow primitives
import { Flow } from '@agent/node';

// Local imports - types
import type { OutputFileInfo } from '@agent/output/types';
import {
  OutputProcessingAction,
  createOutputProcessingShared,
} from './OutputProcessingTypes';
import {
  PrepareOutputNode,
  XmlValidationNode,
  ProcessFilesNode,
  IndentFilesNode,
  ReplaceInputCommandsNode,
  FinalizeOutputNode,
  type OutputProcessingServices,
  type OutputProcessingParams,
} from './OutputProcessingNodes';
import type {
  OutputProcessingShared,
  OutputProcessingInput,
} from './OutputProcessingTypes';

// Local imports - nodes

// Local imports - types

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
 * Creates an output processing flow with all nodes wired together.
 *
 * Flow structure:
 * ```
 * prepare
 *   ├─[default]──→ xmlValidation ──→ processFiles ──→ indentFiles ──→ replaceInputs ──→ finalize
 *   ├─[skip_validation]──→ processFiles ──→ ...
 *   └─[error]──→ (end)
 *
 * replaceInputs
 *   ├─[default]──→ finalize
 *   └─[skip_diff]──→ finalize
 * ```
 */
export function createOutputProcessingFlow(): Flow<
  OutputProcessingShared,
  OutputProcessingParams
> {
  // Create node instances
  const prepareNode = new PrepareOutputNode();
  const xmlValidationNode = new XmlValidationNode();
  const processFilesNode = new ProcessFilesNode();
  const indentFilesNode = new IndentFilesNode();
  const replaceInputsNode = new ReplaceInputCommandsNode();
  const finalizeNode = new FinalizeOutputNode();

  // Wire the main flow path: prepare → xmlValidation → processFiles → indent → replace → finalize
  prepareNode.next(xmlValidationNode);
  xmlValidationNode.next(processFilesNode);
  processFilesNode.next(indentFilesNode);
  indentFilesNode.next(replaceInputsNode);
  replaceInputsNode.next(finalizeNode);

  // Alternative paths
  // Skip XML validation - go directly to processFiles
  prepareNode.on(OutputProcessingAction.SKIP_VALIDATION, processFilesNode);

  // Skip diff generation - still go to finalize
  replaceInputsNode.on(OutputProcessingAction.SKIP_DIFF, finalizeNode);

  // Error handling - prepare node errors end the flow
  // (no transition defined for ERROR means flow ends)

  // Complete transitions - finalize ends the flow
  // (no transition defined for COMPLETE means flow ends)

  return new Flow<OutputProcessingShared, OutputProcessingParams>(prepareNode);
}

// ============================================================================
// RUNNER FUNCTION
// ============================================================================

/**
 * Runs the output processing flow with the given input and services.
 *
 * This is the main entry point for output processing, providing a clean
 * interface that hides the flow internals.
 *
 * @param input - Input configuration for processing
 * @param services - Required services (xmlManager, logger, etc.)
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
 *     xmlManager: this.outputHandler.xmlManager,
 *     logger: this.logger,
 *     fileService: this.fileService,
 *     indentLatexFile: (loc) => this.outputHandler.indentLatexFile(loc),
 *     replaceInputCommands: (base, out) => replaceInputCommands(base, out, this.logger),
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
