// Third-party imports
import * as vscode from 'vscode';
import { z } from 'zod';

// Local imports
import type { FileOpResult } from '@agent/types';
import { parseWithErrorDisplay } from '@frontend/ui/errorHandlingUtils';
import {
  runPack,
  runPackSingle,
  runPackMultiple,
  runPackRunDir,
} from '@housekeeping';
import * as logger from '@logger/logUtils';
import { ExecutionIdSchema } from '@shared/schemas';
import { WorkspaceFS } from '@utils/files';
import {
  emitClearMissingOutputs,
  type ClearMissingOutputsOptions,
} from './streamEventUtils';

const CHANNEL = 'packCommands';
logger.initialize(CHANNEL);

const RequiredString = z.string().min(1);

const BasePackSchema = z.object({
  inputFile: RequiredString,
  agent: RequiredString,
  model: RequiredString,
});

const PackConfigSchema = BasePackSchema.extend({
  model: z.string().prefault(''),
  outputFiles: z.array(z.string()).prefault([]),
  streamId: z.string().optional(),
  executionId: ExecutionIdSchema.optional(),
  skipProgressViewClear: z.boolean().optional(),
});

const PackMultipleSchema = BasePackSchema.extend({
  inputFile: z.string().prefault(''),
  inputFiles: z.array(z.string()).prefault([]),
}).refine((d) => d.inputFile || d.inputFiles.length > 0, {
  error: 'inputFile or inputFiles required',
});

function showPackResult(result: FileOpResult, inputFile: string): void {
  switch (result.status) {
    case 'success': {
      const folder = result.outputFolder;
      if (!folder) return;
      vscode.window
        .showInformationMessage(`Files packed into ${folder}`, 'Open Folder')
        .then((sel) => {
          if (sel === 'Open Folder') {
            void vscode.commands.executeCommand(
              'revealFileInOS',
              vscode.Uri.file(WorkspaceFS.fullPath(folder)),
            );
          }
        });
      break;
    }
    case 'noFiles':
      vscode.window.showInformationMessage(
        `No files found to pack for ${inputFile}`,
      );
      break;
    case 'missingParams':
      vscode.window.showErrorMessage('Missing required parameters for pack');
      break;
    case 'error':
      vscode.window.showErrorMessage(`Error during packing: ${result.error}`);
      break;
  }
}

interface PackParams {
  agent: string;
  model: string;
  inputFile: string;
}

async function executePackOperation<T extends PackParams>(
  schema: z.ZodType<T>,
  input: unknown,
  label: string,
  runOperation: (data: T) => Promise<FileOpResult>,
  getClearOptions: (data: T) => ClearMissingOutputsOptions | null,
): Promise<void> {
  const data = await parseWithErrorDisplay(CHANNEL, schema, input, label);
  if (!data) return;

  const result = await runOperation(data);
  showPackResult(result, data.inputFile);

  const clearOptions = getClearOptions(data);
  if (clearOptions) {
    emitClearMissingOutputs(clearOptions);
  }
}

async function handlePack(config: unknown): Promise<void> {
  return executePackOperation(
    PackConfigSchema,
    config,
    'config',
    async (data) => {
      const runWorkspacePack = (): Promise<FileOpResult> =>
        runPack(data.model, data.inputFile, data.agent, data.outputFiles);

      // Toolbar-driven invocations pass an executionId: snapshot the runDir
      // AND the workspace. The workspace pass is a no-op for new runs (their
      // outputs live only inside the runDir), but it catches legacy runs
      // whose outputs still sit beside the source — those runs also
      // produce a runDir via `ensureRunDir`, so keying solely off
      // `runPackRunDir` returning non-noFiles skips real workspace
      // artifacts and would produce an empty snapshot.
      if (data.executionId) {
        const runDirResult = await runPackRunDir(
          data.executionId,
          data.agent,
          data.model,
          data.inputFile,
        );
        const workspaceResult = await runWorkspacePack();
        // Surface errors from either leg — a failed runDir snapshot
        // (permission denied, disk full) must not be masked by a
        // successful workspace pack, or the user sees "Pack complete"
        // while no primary run-dir snapshot was created.
        if (runDirResult.status === 'error') return runDirResult;
        if (workspaceResult.status === 'error') return workspaceResult;
        return workspaceResult.status !== 'noFiles'
          ? workspaceResult
          : runDirResult;
      }
      return runWorkspacePack();
    },
    (data) => {
      if (data.skipProgressViewClear) return null;
      if (data.streamId) return { streamIdOverride: data.streamId };
      return {
        streamConfig: {
          agent: data.agent,
          model: data.model,
          inputFile: data.inputFile,
          outputFiles: data.outputFiles,
        },
      };
    },
  );
}

async function handlePackSingle(
  inputFile: string,
  agent: string,
  model: string,
): Promise<void> {
  return executePackOperation(
    BasePackSchema,
    { inputFile, agent, model },
    'params',
    (data) => runPackSingle(data.model, data.inputFile, data.agent),
    (data) => ({
      streamConfig: {
        agent: data.agent,
        model: data.model,
        inputFile: data.inputFile,
        outputFiles: [],
      },
    }),
  );
}

async function handlePackMultiple(
  inputFile: string,
  agent: string,
  model: string,
  inputFiles: string[] = [],
): Promise<void> {
  return executePackOperation(
    PackMultipleSchema,
    { inputFile, agent, model, inputFiles },
    'params',
    (data) =>
      runPackMultiple(data.model, data.inputFile, data.agent, data.inputFiles),
    (data) => ({
      streamConfig: {
        agent: data.agent,
        model: data.model,
        inputFile: data.inputFile,
        outputFiles: data.inputFiles,
      },
    }),
  );
}

export function registerPackCommands(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('texra.pack', handlePack),
    vscode.commands.registerCommand('texra.packSingle', handlePackSingle),
    vscode.commands.registerCommand('texra.packMultiple', handlePackMultiple),
  );
}
