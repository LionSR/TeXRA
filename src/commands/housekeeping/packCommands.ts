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

/** For packSingle - all fields required */
const PackParamsSchema = z.object({
  inputFile: RequiredString,
  agent: RequiredString,
  model: RequiredString,
});

/** For pack command - model optional (may come from stored config) */
const PackConfigSchema = z
  .object({
    inputFile: RequiredString,
    agent: RequiredString,
    model: z.string().prefault(''),
    outputFiles: z.array(z.string()).prefault([]),
    useMultipleOutputs: z.boolean().optional(),
    streamId: z.string().optional(),
    skipProgressViewClear: z.boolean().optional(),
  })
  .transform((c) => ({
    ...c,
    useMultipleOutputs: c.useMultipleOutputs ?? c.outputFiles.length > 0,
  }));

/** For packMultiple - inputFile optional if outputFiles provided */
const PackMultipleSchema = z
  .object({
    agent: RequiredString,
    model: RequiredString,
    inputFile: z.string().prefault(''),
    outputFiles: z.array(z.string()).prefault([]),
  })
  .refine((d) => d.inputFile || d.outputFiles.length > 0, {
    error: 'inputFile or outputFiles required',
  });

// --- Helpers ---

function showPackResult(result: FileOpResult, inputFile: string): void {
  if (result.status === 'success') {
    const folder = result.outputFolder;
    if (folder) {
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
    }
    return;
  }

  const messages: Record<
    Exclude<FileOpResult['status'], 'success'>,
    { text: string; isError: boolean }
  > = {
    noFiles: {
      text: `No files found to pack for ${inputFile}`,
      isError: false,
    },
    missingParams: {
      text: 'Missing required parameters for pack',
      isError: true,
    },
    error: { text: `Error during packing: ${result.error}`, isError: true },
  };
  const msg = messages[result.status];
  if (msg.isError) {
    vscode.window.showErrorMessage(msg.text);
  } else {
    vscode.window.showInformationMessage(msg.text);
  }
}

// --- Handlers ---

async function handlePack(config: unknown): Promise<void> {
  const data = await parseWithErrorDisplay(
    CHANNEL,
    PackConfigSchema,
    config,
    'config',
  );
  if (!data) return;

  const {
    agent,
    model,
    inputFile,
    outputFiles,
    useMultipleOutputs,
    streamId,
    skipProgressViewClear,
  } = data;

  if (outputFiles.length > 1 && !useMultipleOutputs) {
    logger.warn(
      CHANNEL,
      'Multiple output files but multi-output mode disabled',
    );
  }

  const result = await runPack(
    model,
    inputFile,
    agent,
    useMultipleOutputs ? outputFiles : [],
  );
  showPackResult(result, inputFile);

  if (!skipProgressViewClear) {
    emitClearMissingOutputs({
      streamConfig: { agent, model, inputFile },
      useMultipleOutputs,
      streamIdOverride: streamId,
    });
  }
}

async function handlePackSingle(
  inputFile: string,
  agent: string,
  model: string,
): Promise<void> {
  const data = await parseWithErrorDisplay(
    CHANNEL,
    PackParamsSchema,
    { inputFile, agent, model },
    'params',
  );
  if (!data) return;

  const result = await runPackSingle(data.model, data.inputFile, data.agent);
  showPackResult(result, data.inputFile);
  emitClearMissingOutputs({
    streamConfig: {
      agent: data.agent,
      model: data.model,
      inputFile: data.inputFile,
    },
    useMultipleOutputs: false,
  });
}

async function handlePackMultiple(
  inputFile: string,
  agent: string,
  model: string,
  outputFiles: string[] = [],
): Promise<void> {
  const data = await parseWithErrorDisplay(
    CHANNEL,
    PackMultipleSchema,
    { inputFile, agent, model, outputFiles },
    'params',
  );
  if (!data) return;
  const result = await runPackMultiple(
    data.model,
    data.inputFile,
    data.agent,
    data.outputFiles,
  );
  showPackResult(result, data.inputFile);
  emitClearMissingOutputs({
    streamConfig: {
      agent: data.agent,
      model: data.model,
      inputFile: data.inputFile,
    },
    useMultipleOutputs: true,
  });
}

// --- Registration ---

export function registerPackCommands(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('texra.pack', handlePack),
    vscode.commands.registerCommand('texra.packSingle', handlePackSingle),
    vscode.commands.registerCommand('texra.packMultiple', handlePackMultiple),
  );
}
