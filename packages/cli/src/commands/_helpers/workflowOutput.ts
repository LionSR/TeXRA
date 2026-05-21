import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { AgentEntry } from '@agent/index';
import type { AgentConfigPayload } from '@agent/core/AgentConfig';
import { AgentCategory } from '@agent/core/AgentDataclass';
import type { OutputFileSummary } from '@agent/runtime/AgentFlowResult';
import { getSafeDocumentRelativePath } from '@agent/utils/outputFileUtils';
import { EXECUTION_STATUS, type ExecutionStatus } from '@shared/schemas';
import { getRunDir } from '@utils/files';

import {
  cliTerminalStatus,
  type CliRunResult,
  type ExecuteAgentResult,
} from './terminalStatus';
import type { CliContext } from '../../runtime/cliContext';

export type CliWorkflowRunResult = Extract<
  CliRunResult,
  { category: 'workflow' }
>;

export interface WorkflowOutputResolutionOptions {
  readonly expectedOutputFiles?: readonly string[];
  readonly runDirectory?: string;
  readonly terminalStatus?: ExecutionStatus;
}

function outputCopyRelativePath(output: OutputFileSummary): string {
  const relativePath =
    output.relativePath || path.basename(output.absolutePath);
  const parts = relativePath.replaceAll('\\', '/').split('/');
  const withoutRoundDir = /^r\d+$/.test(parts[0] ?? '')
    ? parts.slice(1)
    : parts;
  return getSafeDocumentRelativePath(withoutRoundDir.join('/'));
}

function expectedOutputCopyRelativePath(outputFile: string): string {
  return getSafeDocumentRelativePath(outputFile);
}

export function expectedOutputFilesForOutputDir(
  agent: AgentEntry | undefined,
  inputFiles: readonly string[],
): readonly string[] {
  const defaultOutputFiles = (agent?.defaultOutputFiles ?? []).filter(Boolean);
  return defaultOutputFiles.length > 0 ? defaultOutputFiles : inputFiles;
}

function shouldUseOutputForCopy(
  existing: OutputFileSummary | undefined,
  candidate: OutputFileSummary,
): boolean {
  return existing == null || candidate.round > existing.round;
}

function latestWorkflowOutput(
  outputs: readonly OutputFileSummary[],
): OutputFileSummary | undefined {
  let latest: OutputFileSummary | undefined;
  for (const output of outputs) {
    if (latest == null || output.round >= latest.round) {
      latest = output;
    }
  }
  return latest;
}

export async function resolveWorkflowOutput(
  outputFile: string | undefined,
  outputDir: string | undefined,
  result: ExecuteAgentResult,
  context: CliContext,
  options: WorkflowOutputResolutionOptions = {},
): Promise<{
  copiedOutput: string | undefined;
  displayResult: CliRunResult;
}> {
  const terminalStatus = options.terminalStatus ?? cliTerminalStatus(result);
  if (
    result.category === AgentCategory.Workflow &&
    result.outputs.length === 0 &&
    (outputFile || outputDir)
  ) {
    if (terminalStatus === EXECUTION_STATUS.INTERRUPTED) {
      return {
        copiedOutput: undefined,
        displayResult: {
          ...result,
          terminalStatus,
        },
      };
    }
    if (outputDir) {
      throw new Error(
        `Workflow ${terminalStatus} without generated outputs; nothing was copied to ${outputDir}.`,
      );
    }
    if (outputFile) {
      throw new Error(
        `Workflow ${terminalStatus} without a generated output; ${outputFile} was not written.`,
      );
    }
  }

  const baseResult: CliRunResult = {
    ...result,
    terminalStatus,
    ...(result.category === AgentCategory.Workflow
      ? { runDirectory: options.runDirectory ?? getRunDir(result.executionId) }
      : {}),
  };
  if (outputDir && result.category === AgentCategory.Workflow) {
    const targetRoot = path.isAbsolute(outputDir)
      ? outputDir
      : path.join(context.cwd, outputDir);
    const outputsByRelativePath = new Map<string, OutputFileSummary>();
    for (const output of result.outputs) {
      const relativePath = outputCopyRelativePath(output);
      if (
        shouldUseOutputForCopy(outputsByRelativePath.get(relativePath), output)
      ) {
        outputsByRelativePath.set(relativePath, output);
      }
    }

    const copiedOutputs: string[] = [];
    for (const [relativePath, output] of outputsByRelativePath) {
      const targetPath = path.join(targetRoot, relativePath);
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.copyFile(output.absolutePath, targetPath);
      copiedOutputs.push(targetPath);
    }

    const expectedOutputFiles = options.expectedOutputFiles ?? [];
    const missing = expectedOutputFiles
      .map(expectedOutputCopyRelativePath)
      .filter((expected) => !outputsByRelativePath.has(expected));
    if (missing.length > 0) {
      throw new Error(
        `Workflow ${terminalStatus} without expected output${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}; copied ${copiedOutputs.length} of ${expectedOutputFiles.length} expected output${expectedOutputFiles.length === 1 ? '' : 's'} to ${targetRoot}.`,
      );
    }

    const displayResult: CliRunResult = {
      ...baseResult,
      copiedOutputs,
    };
    return { copiedOutput: undefined, displayResult };
  }

  if (!outputFile || result.category !== AgentCategory.Workflow) {
    return { copiedOutput: undefined, displayResult: baseResult };
  }

  const finalOutput = latestWorkflowOutput(result.outputs);
  if (!finalOutput) {
    return { copiedOutput: undefined, displayResult: baseResult };
  }

  const targetPath = path.isAbsolute(outputFile)
    ? outputFile
    : path.join(context.cwd, outputFile);
  if (path.resolve(finalOutput.absolutePath) !== path.resolve(targetPath)) {
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.copyFile(finalOutput.absolutePath, targetPath);
  }

  const displayResult: CliRunResult = {
    ...baseResult,
    copiedOutput: targetPath,
  };
  return { copiedOutput: targetPath, displayResult };
}

export function formatWorkflowTextResult(result: CliWorkflowRunResult): string {
  if (result.copiedOutputs?.length) {
    return result.copiedOutputs.join('\n');
  }
  if (result.copiedOutput) {
    return result.copiedOutput;
  }

  const finalOutput = result.outputs.at(-1);
  return finalOutput?.absolutePath ?? result.runDirectory ?? result.status;
}

export function resumeWorkflowOutputFile(
  config: AgentConfigPayload,
): string | undefined {
  if (config.agentCategory !== AgentCategory.Workflow) return undefined;

  const resolveStoredOutputFile = (outputFile: string | undefined | null) => {
    const trimmed = outputFile?.trim();
    if (!trimmed) return undefined;
    if (path.isAbsolute(trimmed)) return trimmed;

    const workingDirectory = config.workingDirectory?.trim();
    return workingDirectory ? path.join(workingDirectory, trimmed) : trimmed;
  };

  const cliOutputFile = resolveStoredOutputFile(config.cliOutputFile);
  if (cliOutputFile) return cliOutputFile;

  const outputFiles = config.outputFiles ?? [];
  return outputFiles.length === 1
    ? resolveStoredOutputFile(outputFiles[0])
    : undefined;
}
