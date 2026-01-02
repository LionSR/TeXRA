// Third-party imports
import * as vscode from 'vscode';
import { z } from 'zod';

// Local imports
import { showLoggedMessage, showFileOperationResult } from '@common/errors';
import * as logger from '@logger/logUtils';
import { bus } from '@eventBus/ProgressEventBus';
import { runPack, runPackSingle, runPackMultiple } from '@housekeeping';
import { getStreamTabId } from '@/logger/streamUtils';

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
    useMultipleOutputs: c.useMultipleOutputs ?? c.outputFiles.length > 1,
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

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((i) =>
      i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message,
    )
    .join(', ');
}

// --- Handlers ---

async function handlePack(config: unknown) {
  const parsed = PackConfigSchema.safeParse(config);
  if (!parsed.success) {
    await showLoggedMessage(
      CHANNEL,
      `Invalid config: ${formatZodError(parsed.error)}`,
    );
    return;
  }

  const {
    agent,
    model,
    inputFile,
    outputFiles,
    useMultipleOutputs,
    streamId,
    skipProgressViewClear,
  } = parsed.data;

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
  await showFileOperationResult(result, {
    channel: CHANNEL,
    operationName: 'pack',
    inputFile,
    showOpenFolder: true,
  });

  if (!skipProgressViewClear) {
    bus.emit(
      'clearMissingOutputs',
      streamId ||
        getStreamTabId(agent, model, inputFile, { useMultipleOutputs }),
    );
  }
}

async function handlePackSingle(
  inputFile: string,
  agent: string,
  model: string,
) {
  const parsed = PackParamsSchema.safeParse({ inputFile, agent, model });
  if (!parsed.success) {
    await showLoggedMessage(
      CHANNEL,
      `Invalid params: ${formatZodError(parsed.error)}`,
    );
    return;
  }

  const data = parsed.data;
  const result = await runPackSingle(data.model, data.inputFile, data.agent);
  await showFileOperationResult(result, {
    channel: CHANNEL,
    operationName: 'pack',
    inputFile: data.inputFile,
    showOpenFolder: true,
  });
  bus.emit(
    'clearMissingOutputs',
    getStreamTabId(data.agent, data.model, data.inputFile, {
      useMultipleOutputs: false,
    }),
  );
}

async function handlePackMultiple(
  inputFile: string,
  agent: string,
  model: string,
  outputFiles: string[] = [],
) {
  const parsed = PackMultipleSchema.safeParse({
    inputFile,
    agent,
    model,
    outputFiles,
  });
  if (!parsed.success) {
    await showLoggedMessage(
      CHANNEL,
      `Invalid params: ${formatZodError(parsed.error)}`,
    );
    return;
  }

  const data = parsed.data;
  const result = await runPackMultiple(
    data.model,
    data.inputFile,
    data.agent,
    data.outputFiles,
  );
  await showFileOperationResult(result, {
    channel: CHANNEL,
    operationName: 'pack',
    inputFile: data.inputFile,
    showOpenFolder: true,
  });
  bus.emit(
    'clearMissingOutputs',
    getStreamTabId(data.agent, data.model, data.inputFile, {
      useMultipleOutputs: true,
    }),
  );
}

// --- Registration ---

export function registerPackCommands(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand('texra.pack', handlePack),
    vscode.commands.registerCommand('texra.packSingle', handlePackSingle),
    vscode.commands.registerCommand('texra.packMultiple', handlePackMultiple),
  );
}

export const packCommands = {
  handlePack,
  handlePackSingle,
  handlePackMultiple,
};
