/**
 * Output processing nodes following pocketflow architecture.
 *
 * Each node follows the prep -> exec -> post pattern:
 * - prep: Read from shared store, prepare data for computation
 * - exec: Pure computation (no shared store access)
 * - post: Write results to shared store, return action for transition
 *
 * This separation ensures clear data flow and testability.
 */

// Standard library imports
import * as path from 'path';

// Local imports - core flow primitives
import { Node } from '@agent/node';
import type { OutputFileInfo, OutputXmlSummary, FileLocation } from '@agent/output/types';
import type { XmlOutputManager } from '@agent/output/XmlOutputManager';
import type { AgentLogger } from '@logger/AgentLogger';
import { AbsoluteFS } from '@utils/files';
import type { TaskRunFileService } from '@utils/files';

// Local imports - types
import {
  OutputProcessingAction,
  type OutputProcessingActionType,
} from './OutputProcessingTypes';
import type {
  OutputProcessingShared,
  XmlValidationResult,
  FileProcessingResult,
} from './OutputProcessingTypes';

// ============================================================================
// SERVICE PARAMS - Injected dependencies for nodes
// ============================================================================

/**
 * Services required by output processing nodes.
 * Passed via node params to maintain pocketflow's separation of concerns.
 */
export interface OutputProcessingServices {
  xmlManager: XmlOutputManager;
  logger: AgentLogger;
  fileService: TaskRunFileService;
  indentLatexFile: (location: FileLocation) => Promise<void>;
  replaceInputCommands: (
    baseFiles: readonly FileLocation[],
    outputFiles: FileLocation[],
  ) => Promise<void>;
}

/**
 * Params interface for output processing nodes.
 * Must satisfy NonIterableObject constraint from pocketflow.
 */
export interface OutputProcessingParams {
  services: OutputProcessingServices;
  // Index signature required by NonIterableObject constraint
  [key: string]: unknown;
}

// ============================================================================
// PREPARE NODE - Reads output file and determines processing mode
// ============================================================================

interface PreparePrep {
  outputPath: string;
  isMultipleOutputs: boolean;
  shouldValidateXml: boolean;
}

interface PrepareExec {
  content: string | null;
  exists: boolean;
}

/**
 * Prepares output processing by reading the raw output file
 * and determining the processing mode (single vs multiple outputs).
 */
export class PrepareOutputNode extends Node<
  OutputProcessingShared,
  OutputProcessingParams
> {
  async prep(shared: OutputProcessingShared): Promise<PreparePrep> {
    const { input } = shared;
    const isMultipleOutputs =
      Array.isArray(input.agentConfig.outputFiles) &&
      input.agentConfig.outputFiles.length > 0;

    return {
      outputPath: input.outputLocation.absolutePath,
      isMultipleOutputs,
      shouldValidateXml: input.shouldValidateXml,
    };
  }

  async exec(prepRes: PreparePrep): Promise<PrepareExec> {
    const exists = await AbsoluteFS.exists(prepRes.outputPath);
    if (!exists) {
      return { content: null, exists: false };
    }

    const content = await AbsoluteFS.read(prepRes.outputPath);
    return { content, exists: true };
  }

  async post(
    shared: OutputProcessingShared,
    prepRes: PreparePrep,
    execRes: PrepareExec,
  ): Promise<OutputProcessingActionType> {
    const { services } = this._params;

    if (!execRes.exists || execRes.content === null) {
      services.logger.debug(
        `Output file does not exist: ${prepRes.outputPath}`,
      );
      shared.state.shouldContinue = false;
      shared.state.error = new Error(
        `Output file not found: ${prepRes.outputPath}`,
      );
      return OutputProcessingAction.ERROR;
    }

    shared.state.rawContent = execRes.content;
    services.logger.debug(
      `Read ${execRes.content.length} chars from ${prepRes.outputPath}`,
    );

    // Determine next action based on processing mode
    if (!prepRes.shouldValidateXml) {
      return OutputProcessingAction.SKIP_VALIDATION;
    }

    return OutputProcessingAction.DEFAULT;
  }
}

// ============================================================================
// XML VALIDATION NODE - Validates and repairs XML structure
// ============================================================================

interface XmlValidationPrep {
  content: string;
  documentTag: string;
  outputLocation: FileLocation;
}

/**
 * Validates XML structure and repairs if necessary.
 * Only runs if shouldValidateXml is true.
 */
export class XmlValidationNode extends Node<
  OutputProcessingShared,
  OutputProcessingParams
> {
  async prep(shared: OutputProcessingShared): Promise<XmlValidationPrep | null> {
    const { input, state } = shared;
    if (!state.rawContent) {
      return null;
    }

    return {
      content: state.rawContent,
      documentTag: input.documentTag,
      outputLocation: input.outputLocation,
    };
  }

  async exec(
    prepRes: XmlValidationPrep | null,
  ): Promise<XmlValidationResult | null> {
    if (!prepRes) {
      return null;
    }

    const { services } = this._params;

    // Use xmlManager to validate/repair structure
    try {
      await services.xmlManager.ensureCorrectXmlStructure(
        prepRes.outputLocation,
        prepRes.documentTag,
      );

      // Re-read content after potential repair
      const repairedContent = await AbsoluteFS.read(
        prepRes.outputLocation.absolutePath,
      );

      return {
        isValid: true,
        content: repairedContent,
        repairAttempted: repairedContent !== prepRes.content,
      };
    } catch (error) {
      // If repair fails, continue with original content
      return {
        isValid: false,
        content: prepRes.content,
        repairAttempted: true,
      };
    }
  }

  async post(
    shared: OutputProcessingShared,
    _prepRes: XmlValidationPrep | null,
    execRes: XmlValidationResult | null,
  ): Promise<OutputProcessingActionType> {
    const { services } = this._params;

    if (!execRes) {
      return OutputProcessingAction.ERROR;
    }

    shared.state.validatedContent = execRes.content;

    if (execRes.repairAttempted) {
      services.logger.debug(
        `XML validation: repair attempted, valid=${execRes.isValid}`,
      );
    }

    return OutputProcessingAction.DEFAULT;
  }
}

// ============================================================================
// PROCESS FILES NODE - Extracts output files from XML content
// ============================================================================

interface ProcessFilesPrep {
  outputLocation: FileLocation;
  isMultipleOutputs: boolean;
  shouldProcessXml: boolean;
}

/**
 * Processes output content to extract individual files.
 * Handles both single and multiple output scenarios.
 */
export class ProcessFilesNode extends Node<
  OutputProcessingShared,
  OutputProcessingParams
> {
  async prep(shared: OutputProcessingShared): Promise<ProcessFilesPrep> {
    const { input } = shared;
    const isMultipleOutputs =
      Array.isArray(input.agentConfig.outputFiles) &&
      input.agentConfig.outputFiles.length > 0;

    return {
      outputLocation: input.outputLocation,
      isMultipleOutputs,
      shouldProcessXml: input.shouldValidateXml,
    };
  }

  async exec(prepRes: ProcessFilesPrep): Promise<FileProcessingResult> {
    const { services } = this._params;

    try {
      if (prepRes.isMultipleOutputs) {
        // Process multiple outputs from XML
        const processedPairs = await services.xmlManager.processMultipleXmlOutputs(
          prepRes.outputLocation,
        );

        return {
          files: processedPairs || [],
          xmlSummary: null, // Will be captured later
        };
      }

      // Process single output
      if (prepRes.shouldProcessXml) {
        const processed = await services.xmlManager.processSingleXmlOutput(
          prepRes.outputLocation,
        );
        return {
          files: processed ? [processed] : [],
          xmlSummary: null,
        };
      }

      // No XML processing - use raw file
      const fileInfo: OutputFileInfo = {
        source: path.basename(prepRes.outputLocation.absolutePath),
        location: prepRes.outputLocation,
        lineage: null,
        diff: null,
      };
      return {
        files: [fileInfo],
        xmlSummary: null,
      };
    } catch (error) {
      services.logger.debug(`Error processing files: ${error}`);
      return { files: [], xmlSummary: null };
    }
  }

  async post(
    shared: OutputProcessingShared,
    _prepRes: ProcessFilesPrep,
    execRes: FileProcessingResult,
  ): Promise<OutputProcessingActionType> {
    const { services } = this._params;

    shared.state.processedFiles = execRes.files;
    shared.state.xmlSummary = execRes.xmlSummary;

    services.logger.debug(`Processed ${execRes.files.length} output files`);

    if (execRes.files.length === 0) {
      shared.state.shouldContinue = false;
      return OutputProcessingAction.COMPLETE;
    }

    return OutputProcessingAction.DEFAULT;
  }
}

// ============================================================================
// INDENT FILES NODE - Formats LaTeX files
// ============================================================================

interface IndentFilesPrep {
  files: OutputFileInfo[];
}

interface IndentFilesExec {
  indentedCount: number;
}

/**
 * Indents/formats LaTeX output files for better readability.
 */
export class IndentFilesNode extends Node<
  OutputProcessingShared,
  OutputProcessingParams
> {
  async prep(shared: OutputProcessingShared): Promise<IndentFilesPrep> {
    return {
      files: shared.state.processedFiles,
    };
  }

  async exec(prepRes: IndentFilesPrep): Promise<IndentFilesExec> {
    const { services } = this._params;
    let indentedCount = 0;

    for (const file of prepRes.files) {
      if (file.location.absolutePath.endsWith('.tex')) {
        await services.indentLatexFile(file.location);
        indentedCount++;
      }
    }

    return { indentedCount };
  }

  async post(
    shared: OutputProcessingShared,
    _prepRes: IndentFilesPrep,
    execRes: IndentFilesExec,
  ): Promise<OutputProcessingActionType> {
    const { services } = this._params;

    if (execRes.indentedCount > 0) {
      services.logger.debug(`Indented ${execRes.indentedCount} LaTeX files`);
    }

    return OutputProcessingAction.DEFAULT;
  }
}

// ============================================================================
// REPLACE INPUT COMMANDS NODE - Updates \input references
// ============================================================================

interface ReplaceInputsPrep {
  baseFiles: readonly FileLocation[];
  outputFiles: FileLocation[];
  hasBaseFiles: boolean;
}

/**
 * Replaces \input commands in base files to reference new outputs.
 */
export class ReplaceInputCommandsNode extends Node<
  OutputProcessingShared,
  OutputProcessingParams
> {
  async prep(shared: OutputProcessingShared): Promise<ReplaceInputsPrep> {
    const { input, state } = shared;
    const outputFiles = state.processedFiles.map((f) => f.location);
    const hasBaseFiles = input.baseFiles.length > 0;

    return {
      baseFiles: input.baseFiles,
      outputFiles,
      hasBaseFiles,
    };
  }

  async exec(prepRes: ReplaceInputsPrep): Promise<boolean> {
    if (!prepRes.hasBaseFiles || prepRes.outputFiles.length === 0) {
      return false;
    }

    const { services } = this._params;
    await services.replaceInputCommands(prepRes.baseFiles, prepRes.outputFiles);
    return true;
  }

  async post(
    shared: OutputProcessingShared,
    prepRes: ReplaceInputsPrep,
    execRes: boolean,
  ): Promise<OutputProcessingActionType> {
    const { services } = this._params;

    if (execRes) {
      services.logger.debug(
        `Replaced input commands in ${prepRes.baseFiles.length} base files`,
      );
    }

    // Check if we should skip diff generation
    if (!shared.input.endTurn) {
      return OutputProcessingAction.SKIP_DIFF;
    }

    return OutputProcessingAction.DEFAULT;
  }
}

// ============================================================================
// FINALIZE NODE - Completes processing and returns result
// ============================================================================

interface FinalizePrep {
  processedFiles: OutputFileInfo[];
  xmlSummary: OutputXmlSummary | null;
  currRound: number;
}

/**
 * Finalizes output processing and prepares the result.
 */
export class FinalizeOutputNode extends Node<
  OutputProcessingShared,
  OutputProcessingParams
> {
  async prep(shared: OutputProcessingShared): Promise<FinalizePrep> {
    return {
      processedFiles: shared.state.processedFiles,
      xmlSummary: shared.state.xmlSummary,
      currRound: shared.input.currRound,
    };
  }

  async exec(prepRes: FinalizePrep): Promise<void> {
    // No computation needed - just finalize
    return;
  }

  async post(
    shared: OutputProcessingShared,
    prepRes: FinalizePrep,
    _execRes: void,
  ): Promise<OutputProcessingActionType> {
    const { services } = this._params;

    services.logger.debug(
      `Output processing complete for round ${prepRes.currRound}: ${prepRes.processedFiles.length} files`,
    );

    shared.state.shouldContinue = false;
    return OutputProcessingAction.COMPLETE;
  }
}
