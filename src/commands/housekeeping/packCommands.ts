// Third-party imports
import * as vscode from 'vscode';
import { z } from 'zod';

// Local imports
import type { FileOpResult } from '@agent/types/ResultTypes';
import { parseWithErrorDisplay } from '@common/errors';
import * as logger from '@logger/logUtils';
import { WorkspaceFS } from '@utils/files';
import { runPack, runPackSingle, runPackMultiple } from '@housekeeping';
import { emitClearMissingOutputs } from './streamEventUtils';

const CHANNEL = 'packCommands';
logger.initialize(CHANNEL);

// --- Schemas ---

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

// --- Helpers ---

const PACK_RESULT_MESSAGES: Record<
  Exclude<FileOpResult['status'], 'success'>,
  { template: string; isError: boolean }
> = {
  noFiles: {
    template: 'No files found to pack for {inputFile}',
    isError: false,
  },
  missingParams: {
    template: 'Missing required parameters for pack',
    isError: true,
  },
  error: { template: 'Error during packing: {error}', isError: true },
};

function showPackResult(result: FileOpResult, inputFile: string): void {
  if (result.status === 'success') {
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
    return;
  }

  const { template, isError } = PACK_RESULT_MESSAGES[result.status];
  const text = template
    .replace('{inputFile}', inputFile)
    .replace('{error}', result.error ?? '');
  const showMessage = isError
    ? vscode.window.showErrorMessage
    : vscode.window.showInformationMessage;
  showMessage(text);
}

interface PackParams {
  agent: string;
  model: string;
  inputFile: string;
}

interface PackClearOptions {
  streamConfig: PackParams;
  useMultipleOutputs: boolean;
  streamIdOverride?: string;
}

async function executePackOperation<T extends PackParams>(
  schema: z.ZodType<T>,
  input: unknown,
  label: string,
  runOperation: (data: T) => Promise<FileOpResult>,
  clearOptions: (data: T) => PackClearOptions | null,
): Promise<void> {
  const data = await parseWithErrorDisplay(CHANNEL, schema, input, label);
  if (!data) return;

  const result = await runOperation(data);
  showPackResult(result, data.inputFile);

  const options = clearOptions(data);
  if (options) {
    emitClearMissingOutputs(options);
  }
}

// --- Handlers ---

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
    (data) =>
      data.skipProgressViewClear
        ? null
        : {
            streamConfig: {
              agent: data.agent,
              model: data.model,
              inputFile: data.inputFile,
            },
            useMultipleOutputs: data.useMultipleOutputs,
            streamIdOverride: data.streamId,
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
      },
      useMultipleOutputs: false,
    }),
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
    (data) => ({
      streamConfig: {
        agent: data.agent,
        model: data.model,
        inputFile: data.inputFile,
      },
      useMultipleOutputs: true,
    }),
  );
}

// --- Registration ---

export function registerPackCommands(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('texra.pack', handlePack),
    vscode.commands.registerCommand('texra.packSingle', handlePackSingle),
    vscode.commands.registerCommand('texra.packMultiple', handlePackMultiple),
  );
}
