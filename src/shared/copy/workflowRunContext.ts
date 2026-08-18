import {
  roundIndexedEntries,
  runIdentityDisplayName,
  type CompileFailure,
  type FileLocation,
  type OutputFileInfo,
  type RoundIndexed,
  type StreamTabInfo,
} from '@shared/schemas';
import { filterNotNullish } from '@utils/core';

/**
 * Reference to a run-storage file the way an agent prompt addresses it:
 * `/executions/<executionId>/files/<relativePath>`. The one definition of that
 * convention — the compile-fixer prompt builder and the progress view's
 * copy-run-context button both address run storage through it.
 */
export function runStorageFilePath(
  executionId: string,
  relativePath: string,
): string {
  return `/executions/${executionId}/files/${relativePath}`;
}

/**
 * How a location reads in copied text. A run-storage location carries the
 * execution that owns it, so the path resolves without the caller supplying
 * one; workspace paths stay relative because that is how the user (and an
 * agent's file tools) refer to them.
 */
function locationPath(location: FileLocation): string {
  switch (location.kind) {
    case 'runStorage':
      return runStorageFilePath(location.executionId, location.relativePath);
    case 'workspace':
      return location.relativePath;
    case 'external':
      return location.absolutePath;
  }
}

export interface WorkflowRunContextInput {
  stream: StreamTabInfo;
  files: RoundIndexed<OutputFileInfo>;
  compileFailures: RoundIndexed<CompileFailure>;
}

/**
 * Plain-text summary of a workflow run for the user to paste into a new chat.
 *
 * Deliberately not a prompt: it states what the run was and where its files
 * landed, and lets whoever receives it decide what to do. Sections with no
 * rows are dropped rather than printed empty, and a run with neither outputs
 * nor compile failures returns `''` — the caller treats that as "nothing worth
 * copying" and disables its button.
 */
export function formatWorkflowRunContext(
  input: WorkflowRunContextInput,
): string {
  const outputs = roundIndexedEntries(input.files);
  const failures = roundIndexedEntries(input.compileFailures);
  const hasOutputs = outputs.some(([, files]) => files.length > 0);
  const hasFailures = failures.some(([, rows]) => rows.length > 0);
  if (!hasOutputs && !hasFailures) return '';

  const { stream } = input;
  const agent = stream.identity
    ? runIdentityDisplayName(stream.identity)
    : stream.label;
  const model = stream.modelLabel ?? stream.model;

  const lines: (string | undefined)[] = [
    `Workflow run: ${model ? `${agent} (${model})` : agent}`,
    stream.executionId ? `Execution: ${stream.executionId}` : undefined,
    stream.description ? `Goal: ${stream.description}` : undefined,
  ];

  if (hasOutputs) {
    lines.push('', 'Outputs:');
    for (const [round, files] of outputs) {
      for (const file of files) {
        const source = file.source ? ` (source: ${file.source})` : '';
        lines.push(`- r${round}: ${locationPath(file.location)}${source}`);
      }
    }
  }

  if (hasFailures) {
    lines.push('', 'Compile failures:');
    for (const [round, rows] of failures) {
      for (const failure of rows) {
        lines.push(
          `- r${round} ${failure.displayName}: log ${locationPath(failure.log)}`,
        );
      }
    }
  }

  return lines.filter(filterNotNullish).join('\n');
}
