/** Plan the compile-fixer follow-up from one run's recorded documents. */
// Node imports
import * as path from 'node:path';

// Third-party imports
import { Effect, FileSystem, PlatformError, Schema } from 'effect';

// Local imports - run facts and filesystem access
import { decideRunModel, pathToLocationIn } from '@texra-ai/harness/host';
import { entryTypeIn } from '@texra-ai/harness/node';
import {
  toErrorMessage,
  isTaskConfig,
  fileLocationAddressPath,
  isModelOptionAvailable,
  RunIdSchema,
  type AgentConfig,
  type RunId,
} from '@texra-ai/harness/schemas';
import { pluralize } from '@texra-ai/harness/transcript';
import { detectGeneratedLatexdiffArtifact } from '@latex/latexdiff/diffFileNameManager';
import type { RunRequest } from '@texra/controllers/session/runRequests';
import {
  type CompileFailure,
  type ReadonlyRoundIndexed,
  formatRoundLabel,
  type OutputFileInfo,
} from '@texra/shared/plugins/documentOutputs';
import type { documentsOf } from '@texra/shared/plugins/documents';
import type { ModelOptionData } from '@texra/shared/pickerOptions';

/** A workspace probe could not determine the compile-fixer's editable files. */
export class CompileFixerPlanFailed extends Schema.TaggedError<CompileFixerPlanFailed>()(
  'CompileFixerPlanFailed',
  { runId: RunIdSchema, message: Schema.String, cause: Schema.Defect() },
) {}

interface CompileFixerTarget {
  path: string;
  latexdiffArtifact?: { sourcePath: string; sourceExists: boolean };
  missingLatexdiffArtifact?: string;
}

type ProgressFollowUpPlan =
  | { kind: 'warning'; message: string }
  | { kind: 'info'; message: string }
  | { kind: 'execute'; request: RunRequest };

/** Resolve editable targets and a latexFixer request from one documents projection.
 * Model options are read by the caller before it captures the run's current documents.
 * The project root is explicit; only filesystem access comes from Effect context. */
export const planCompileFixer = Effect.fn('planCompileFixer')(
  function* (input: {
    readonly runId: RunId;
    readonly runConfig: AgentConfig | undefined;
    readonly documents: ReturnType<typeof documentsOf> | undefined;
    readonly modelOptions: readonly Pick<
      ModelOptionData,
      'value' | 'availability'
    >[];
    readonly workspaceRoot: string | undefined;
  }): Effect.fn.Return<
    ProgressFollowUpPlan,
    PlatformError.PlatformError,
    FileSystem.FileSystem
  > {
    const compileFailures = Object.values(
      input.documents?.compileFailures ?? {},
    ).flat();
    // The compile-fixer planner serves document tasks only.
    const workflowConfig =
      input.runConfig && isTaskConfig(input.runConfig)
        ? input.runConfig
        : undefined;
    if (!workflowConfig) {
      return {
        kind: 'warning',
        message:
          'No document task found for this stream. Cannot run latexFixer.',
      };
    }

    if (compileFailures.length === 0) {
      return {
        kind: 'info',
        message: 'No compile failures are recorded for this stream.',
      };
    }

    const decision = decideRunModel(
      [
        {
          model: workflowConfig.model,
          reason: 'agent-config',
          fallbackMode: 'silent',
        },
        {
          model: input.modelOptions.find(isModelOptionAvailable)?.value,
          reason: 'access-list-default',
        },
      ],
      (model) =>
        input.modelOptions.some(
          (option) => option.value === model && isModelOptionAvailable(option),
        ),
    );
    if (!decision || decision.unavailable) {
      return {
        kind: 'warning',
        message: 'No model is available to launch latexFixer.',
      };
    }

    const model = decision.model;
    const targets = yield* compileFixerTargets(
      workflowConfig,
      compileFailures,
      input.documents?.files ?? {},
      input.workspaceRoot,
    );
    if (targets.length === 0) {
      return {
        kind: 'warning',
        message:
          'No editable workspace file matched the compile failure. Accept the output into the workspace first, then run latexFixer.',
      };
    }

    const editableFiles = targets.map((target) => target.path);
    return {
      kind: 'execute',
      request: {
        config: {
          ...workflowConfig,
          agent: 'latexFixer',
          model,
          instruction: buildCompileFixerQuestion(
            compileFailures,
            targets,
            input.runId,
          ),
          // A chat with latexFixer, not the task's recipe again.
          script: null,
          inputFiles: editableFiles,
          outputFiles: [],
          editedFile: null,
        },
      },
    };
  },
  (effect, input) =>
    Effect.mapError(
      effect,
      (cause) =>
        new CompileFixerPlanFailed({
          runId: input.runId,
          message: toErrorMessage(cause),
          cause,
        }),
    ),
);

function buildCompileFixerQuestion(
  compileFailures: CompileFailure[],
  targets: CompileFixerTarget[],
  runId: RunId,
): string {
  const runHint = `Run: ${runId}`;
  const editableFiles = targets.map((target) => target.path);
  const editableHint = `Editable workspace ${pluralize(editableFiles.length, 'target')}: ${editableFiles.join(', ')}`;
  const latexdiffLines = targets.flatMap((target) => {
    if (target.missingLatexdiffArtifact) {
      return `- ${target.missingLatexdiffArtifact} was a latexdiff artifact candidate, but it is not present in the workspace. ${target.path} is the inferred source fallback.`;
    }
    const artifact = target.latexdiffArtifact;
    if (!artifact) return [];
    const sourceHint = artifact.sourceExists
      ? ` generated from ${artifact.sourcePath}`
      : `; inferred source ${artifact.sourcePath} is not present in the workspace`;
    const sourceFixHint = artifact.sourceExists
      ? ` If the error originates in the original source document, fix ${artifact.sourcePath} too so a regenerated diff stays fixed.`
      : '';
    return `- ${target.path} is a latexdiff artifact${sourceHint}. If the error comes from broken latexdiff markup (\\DIFadd/\\DIFdel or DIF preamble blocks), repair this artifact in place and keep diff annotations intact.${sourceFixHint}`;
  });
  const latexdiffContext =
    latexdiffLines.length > 0
      ? ['Latexdiff context:', ...latexdiffLines].join('\n')
      : undefined;
  // Both halves of the line address the artifact through the run that
  // owns it, which a run-storage location carries. The run asking about the
  // failure is a second, potentially disagreeing source for the same fact --
  // and when it disagrees (a failure recorded by an earlier run of the
  // stream), it is the wrong one.
  const failureLines = compileFailures.map(
    (failure) =>
      `- ${formatRoundLabel(failure.round)} ${failure.displayName}: output ${fileLocationAddressPath(failure.output)}; compile log ${fileLocationAddressPath(failure.log)}`,
  );

  return [
    'The workflow compile check failed. Diagnose and fix the generated LaTeX output using the compile log context below.',
    runHint,
    editableHint,
    latexdiffContext,
    ...failureLines,
    'Use read_file/edit_file on the editable workspace target files. Use /executions paths only to inspect the generated output and logs.',
    'If the failure is caused by a missing external dependency rather than editable LaTeX, report that clearly instead of inventing the missing file.',
  ]
    .filter(Boolean)
    .join('\n');
}

const compileFixerTargets = Effect.fn('ProgressFollowUp.compileFixerTargets')(
  function* (
    originalConfig: AgentConfig,
    compileFailures: CompileFailure[],
    runOutputs: ReadonlyRoundIndexed<OutputFileInfo>,
    workspaceRoot: string | undefined,
  ): Effect.fn.Return<
    CompileFixerTarget[],
    PlatformError.PlatformError,
    FileSystem.FileSystem
  > {
    if (!workspaceRoot) return [];
    // Prefer the recorded output source, followed by the original inputs.
    const outputByPath = new Map(
      Object.values(runOutputs)
        .flat()
        .map((output) => [output.location.absolutePath, output] as const),
    );

    const generatedOutputSources = compileFailures
      .map((failure) => outputByPath.get(failure.output.absolutePath)?.source)
      .filter((source): source is string => !!source);
    const originalInputRecovery = originalConfig.inputFiles.filter(Boolean);

    const preferred = [...generatedOutputSources, ...originalInputRecovery];
    // The map is the target list: insertion order is the order targets are
    // named in, and a path seen twice keeps its first target, enriched by the
    // second.
    // Each candidate is probed together with the others; the merge below
    // takes them in order.
    const probed = yield* Effect.forEach(
      preferred,
      (candidate) => {
        const location = pathToLocationIn(workspaceRoot, candidate);
        return location.kind !== 'workspace'
          ? Effect.succeed([])
          : compileFixerTargetsForCandidate(
              location.relativePath,
              workspaceRoot,
            );
      },
      { concurrency: 8 },
    );
    const targetByPath = new Map<string, CompileFixerTarget>();
    for (const candidateTargets of probed) {
      for (const target of candidateTargets) {
        const existing = targetByPath.get(target.path);
        if (existing) {
          existing.latexdiffArtifact ??= target.latexdiffArtifact;
          existing.missingLatexdiffArtifact ??= target.missingLatexdiffArtifact;
          continue;
        }
        targetByPath.set(target.path, target);
      }
    }
    return [...targetByPath.values()];
  },
);

const compileFixerTargetsForCandidate = Effect.fn(
  'ProgressFollowUp.compileFixerTargetsForCandidate',
)(function* (
  relativePath: string,
  workspaceRoot: string,
): Effect.fn.Return<
  CompileFixerTarget[],
  PlatformError.PlatformError,
  FileSystem.FileSystem
> {
  const fs = yield* FileSystem.FileSystem;
  const exists = (relative: string) =>
    Effect.map(
      entryTypeIn(fs, path.join(workspaceRoot, relative)),
      (type) => type !== undefined,
    );
  const artifact = detectGeneratedLatexdiffArtifact(relativePath);
  if (!artifact) {
    return (yield* exists(relativePath)) ? [{ path: relativePath }] : [];
  }

  const sourcePath = artifact.sourcePath;
  const [sourceExists, artifactExists] = yield* Effect.all(
    [exists(sourcePath), exists(relativePath)],
    { concurrency: 'unbounded' },
  );
  if (!artifactExists) {
    return sourceExists
      ? [{ path: sourcePath, missingLatexdiffArtifact: relativePath }]
      : [];
  }

  // A user may legitimately name a source file `chapter_diff.tex`. Treat the
  // weak workspace suffix as generated only when its inferred source exists.
  if (artifact.kind === 'workspaceDiff' && !sourceExists) {
    return [{ path: relativePath }];
  }

  const targets: CompileFixerTarget[] = [
    {
      path: relativePath,
      latexdiffArtifact: { sourcePath, sourceExists },
    },
  ];
  if (sourceExists) {
    targets.push({ path: sourcePath });
  }
  return targets;
});
