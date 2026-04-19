// Third-party imports
import * as vscode from 'vscode';
import { z } from 'zod';

// Local imports
import type { FileOpResult } from '@agent/types';
import { parseWithErrorDisplay } from '@common/errors';
import { runPack, runPackSingle, runPackMultiple } from '@housekeeping';
import * as logger from '@logger/logUtils';
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
  useMultipleOutputs: z.boolean().optional(),
  streamId: z.string().optional(),
  skipProgressViewClear: z.boolean().optional(),
}).transform((c) => ({
  ...c,
  useMultipleOutputs: c.useMultipleOutputs ?? c.outputFiles.length > 0,
}));

const PackMultipleSchema = BasePackSchema.extend({
  inputFile: z.string().prefault(''),
  outputFiles: z.array(z.string()).prefault([]),
}).refine((d) => d.inputFile || d.outputFiles.length > 0, {
  error: 'inputFile or outputFiles required',
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
  getClearOptions: (data: T) => ClearMissingOutputsOptions | null = (data) => ({
    streamConfig: {
      agent: data.agent,
      model: data.model,
      inputFile: data.inputFile,
    },
  }),
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
    (data) => {
      if (data.outputFiles.length > 1 && !data.useMultipleOutputs) {
        logger.warn(
          CHANNEL,
          'Multiple output files but multi-output mode disabled',
        );
      }
      return runPack(
        data.model,
        data.inputFile,
        data.agent,
        data.useMultipleOutputs ? data.outputFiles : [],
      );
    },
    (data) => {
      if (data.skipProgressViewClear) return null;
      if (data.streamId) return { streamIdOverride: data.streamId };
      return {
        streamConfig: {
          agent: data.agent,
          model: data.model,
          inputFile: data.inputFile,
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
  );
}

async function handlePackMultiple(
  inputFile: string,
  agent: string,
  model: string,
  outputFiles: string[] = [],
): Promise<void> {
  return executePackOperation(
    PackMultipleSchema,
    { inputFile, agent, model, outputFiles },
    'params',
    (data) =>
      runPackMultiple(data.model, data.inputFile, data.agent, data.outputFiles),
  );
}

export function registerPackCommands(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('texra.pack', handlePack),
    vscode.commands.registerCommand('texra.packSingle', handlePackSingle),
    vscode.commands.registerCommand('texra.packMultiple', handlePackMultiple),
  );
}
