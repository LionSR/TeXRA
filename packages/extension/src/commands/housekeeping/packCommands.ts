// Third-party imports
import * as vscode from 'vscode';
import { z } from 'zod';

// Local imports
import { registerCommands } from '@commands/_shared/registerCommands';
import {
  parseWithErrorDisplay,
  showLoggedMessage,
} from '@frontend/ui/errorHandlingUtils';
import {
  runPack,
  runPackSingle,
  runPackMultiple,
  runPackRunDir,
} from '@housekeeping';
import type { FileOpResult } from '@shared/schemas/opResults';
import { WorkspaceFS } from '@utils/files';
import {
  FileOpParamsSchema,
  fileOpConfigFields,
  mergeRunDirAndWorkspaceResult,
  type FileOpParams,
} from './fileOpSchemas';
import {
  emitClearMissingOutputs,
  type ClearMissingOutputsOptions,
} from './streamEventUtils';

const CHANNEL = 'packCommands';

const PackConfigSchema = FileOpParamsSchema.extend({
  // Pack permits an empty model in config; clean keeps it required.
  model: z.string().prefault(''),
  ...fileOpConfigFields,
});

const PackMultipleSchema = FileOpParamsSchema.extend({
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
      void showLoggedMessage(CHANNEL, 'Missing required parameters for pack');
      break;
    case 'error':
      void vscode.window.showErrorMessage(
        `Error during packing: ${result.error}`,
      );
      break;
  }
}

async function executePackOperation<T extends FileOpParams>(
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
        return mergeRunDirAndWorkspaceResult(runDirResult, workspaceResult);
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
    FileOpParamsSchema,
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
  registerCommands(context, [
    { id: 'texra.pack', handler: handlePack },
    { id: 'texra.packSingle', handler: handlePackSingle },
    { id: 'texra.packMultiple', handler: handlePackMultiple },
  ]);
}
