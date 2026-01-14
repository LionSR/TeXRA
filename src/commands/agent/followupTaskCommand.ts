// Third-party imports
import * as vscode from 'vscode';

// Local imports
import { showLoggedErrorMessage, toErrorMessage } from '@common/errors';
import {
  getMainWebview,
  safeExecuteCommand,
} from '@frontend/system/commandUtils';
import { MAIN_VIEW_COMMANDS } from '@common/webview';
import { createFileMapping } from '@utils/files/fileMappingUtils';
import { pathToLocation } from '@utils/files';
import * as logger from '@logger/logUtils';

const CHANNEL = 'followupTaskCommand';
logger.initialize(CHANNEL);

/**
 * Payload from Progress View for setting up a followup task.
 */
interface FollowupPayload {
  mode: 'workflow' | 'merge';
  agent: string;
  model: string;
  executeImmediately: boolean;
  originalInputFile: string;
  originalInputFiles: string[];
  originalReferenceFile?: string | null;
  originalReferenceFiles?: string[];
  originalAuxiliaryFile?: string | null;
  originalAuxiliaryFiles?: string[];
  outputFiles: string[];
  instruction?: string;
}

/**
 * Register followup task command with VS Code.
 */
export function registerFollowupTaskCommand(
  context: vscode.ExtensionContext,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'texra.setupFollowupTask',
      setupFollowupTask,
    ),
  );

  logger.info(CHANNEL, 'Registered followup task command');
}

/**
 * Set up a followup task in the main webview.
 * Maps output files back to input files and sends the configuration to the main view.
 */
async function setupFollowupTask(payload: FollowupPayload): Promise<void> {
  logger.debug(CHANNEL, 'Setting up followup task', { data: { payload } });

  try {
    // Focus the main view first
    await vscode.commands.executeCommand('texra.mainView.focus');

    // Build file mapping from original inputs to outputs
    const originalInputs = [
      payload.originalInputFile,
      ...(payload.originalInputFiles ?? []),
    ].filter(Boolean);

    const outputLocations = payload.outputFiles.map((p) => pathToLocation(p));
    const inputLocations = originalInputs.map((p) => pathToLocation(p));

    // Create mapping: comparable path → output file location
    const pathMapping = createFileMapping(
      inputLocations,
      outputLocations,
      'contains',
    );

    // Build absolute path lookup: absolute path → output file location
    // pathMapping keys are relative paths, so we need to map absolute → relative → output
    const fileMapping = new Map<string, { absolutePath: string }>();
    for (let i = 0; i < originalInputs.length; i++) {
      const absolutePath = originalInputs[i];
      const location = inputLocations[i];
      // Get the comparable path (relative for workspace files)
      const comparablePath =
        location.kind !== 'external'
          ? location.relativePath
          : location.absolutePath;
      const output = pathMapping.get(comparablePath);
      if (output) {
        fileMapping.set(absolutePath, output);
      }
    }

    // Build the followup configuration for main view
    const followupConfig = buildFollowupConfig(payload, fileMapping);

    // Get the main webview and send the message
    const webviewView = await getMainWebview(CHANNEL);
    if (webviewView) {
      webviewView.webview.postMessage({
        command: MAIN_VIEW_COMMANDS.SETUP_FOLLOWUP_TASK,
        ...followupConfig,
      });

      // If executeImmediately, trigger execution after a short delay
      if (payload.executeImmediately) {
        await executeFollowupImmediately(payload, followupConfig);
      }

      logger.info(CHANNEL, 'Followup task configured in main view');
    } else {
      logger.warn(CHANNEL, 'Main webview not available');
    }
  } catch (error) {
    await showLoggedErrorMessage(
      CHANNEL,
      'Failed to set up followup task',
      error,
    );
  }
}

/**
 * Build the followup configuration from payload and file mapping.
 * @throws Error if merge mode has no mapped edited file
 */
function buildFollowupConfig(
  payload: FollowupPayload,
  fileMapping: Map<string, { absolutePath: string }>,
): Record<string, unknown> {
  const { mode, agent, model, instruction } = payload;

  if (mode === 'merge') {
    // Build list of all file pairs to merge
    const allInputFiles = [
      payload.originalInputFile,
      ...(payload.originalInputFiles ?? []),
    ].filter(Boolean);

    const filePairs: Array<{ baseFile: string; editedFile: string }> = [];
    for (const inputFile of allInputFiles) {
      const outputForInput = fileMapping.get(inputFile);
      if (outputForInput?.absolutePath) {
        filePairs.push({
          baseFile: inputFile,
          editedFile: outputForInput.absolutePath,
        });
      }
    }

    if (filePairs.length === 0) {
      throw new Error(
        `Cannot set up merge: no output files found for any input files. ` +
          'The workflow may not have generated output files.',
      );
    }

    // For single file, use simple merge config
    // For multiple files, include filePairs array for batch processing
    if (filePairs.length === 1) {
      return {
        mode: 'merge',
        agent: 'merge',
        model,
        baseFile: filePairs[0].baseFile,
        editedFile: filePairs[0].editedFile,
        instruction: '',
      };
    }

    // Multiple files: include all pairs
    return {
      mode: 'merge',
      agent: 'merge',
      model,
      baseFile: filePairs[0].baseFile,
      editedFile: filePairs[0].editedFile,
      filePairs, // Array of all file pairs for batch merge
      instruction: '',
    };
  }

  // Workflow mode: replace inputs with their corresponding outputs
  const newInputFile =
    fileMapping.get(payload.originalInputFile)?.absolutePath ??
    payload.originalInputFile;

  const newInputFiles = (payload.originalInputFiles ?? []).map(
    (f) => fileMapping.get(f)?.absolutePath ?? f,
  );

  // Log if any files fell back to originals (no mapping found)
  if (newInputFile === payload.originalInputFile && fileMapping.size > 0) {
    logger.warn(CHANNEL, 'No output mapping found for primary input file', {
      data: { originalInputFile: payload.originalInputFile },
    });
  }

  return {
    mode: 'workflow',
    agent,
    model,
    inputFile: newInputFile,
    inputFiles: newInputFiles,
    referenceFile: payload.originalReferenceFile,
    referenceFiles: payload.originalReferenceFiles,
    auxiliaryFile: payload.originalAuxiliaryFile,
    auxiliaryFiles: payload.originalAuxiliaryFiles,
    instruction: instruction ?? '',
  };
}

/**
 * Execute the followup task immediately after setup.
 */
async function executeFollowupImmediately(
  payload: FollowupPayload,
  config: Record<string, unknown>,
): Promise<void> {
  // Small delay to allow UI to update
  await new Promise((resolve) => setTimeout(resolve, 100));

  if (payload.mode === 'merge') {
    const filePairs = config.filePairs as
      | Array<{ baseFile: string; editedFile: string }>
      | undefined;

    if (filePairs && filePairs.length > 1) {
      // Execute merge_multiple agent for batch processing
      const baseFiles = filePairs.map((p) => p.baseFile);
      const editedFiles = filePairs.map((p) => p.editedFile);

      await safeExecuteCommand('texra.execute', [
        {
          config: {
            agent: 'merge_multiple',
            model: config.model,
            inputFile: baseFiles[0],
            inputFiles: baseFiles.slice(1), // Additional inputs beyond the primary
            editedFile: editedFiles[0],
            editedFiles: editedFiles.slice(1), // Additional editeds beyond the primary
            instruction: '',
          },
        },
      ]);
    } else {
      // Single file merge
      await safeExecuteCommand('texra.merge', [
        undefined,
        config.baseFile,
        config.editedFile,
      ]);
    }
  } else {
    // Execute workflow agent
    await safeExecuteCommand('texra.execute', [
      {
        config: {
          agent: config.agent,
          model: config.model,
          inputFile: config.inputFile,
          inputFiles: config.inputFiles,
          referenceFile: config.referenceFile,
          referenceFiles: config.referenceFiles,
          auxiliaryFile: config.auxiliaryFile,
          auxiliaryFiles: config.auxiliaryFiles,
          instruction: config.instruction,
        },
      },
    ]);
  }
}
