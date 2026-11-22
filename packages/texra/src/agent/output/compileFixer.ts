/** Plan the compile-fixer follow-up from one run's recorded documents. */
// Node imports
import * as path from 'node:path';

// Third-party imports
import { Effect, FileSystem, type PlatformError, Schema } from 'effect';

// Local imports - run facts and filesystem access
import { entryTypeIn } from '@texra-ai/harness/node';
import { withLogChannel, pathToLocationIn } from '@texra-ai/harness/plugins';
import {
  toErrorMessage,
  Rejected,
  fileLocationAddressPath,
  RunIdSchema,
  type AgentConfig,
  type AgentConfigInput,
  type RunId,
  pluralize,
} from '@texra-ai/harness/schemas';
import {
  latexdiffArtifactNote,
  latexdiffArtifactSource,
  type LatexdiffArtifactSource,
} from '@latex/latexdiff/diffFileNameManager';
import {
  type CompileFailure,
  compileFailuresOf,
  formatRoundLabel,
  type RoundOutput,
} from '@texra/shared/plugins/documentOutputs';
import { entryAgent } from '@texra/agent/entryAgent';
import type { ModelOptionData } from '@texra/shared/pickerOptions';
import { decideLaunchModel } from '@texra/model/modelOptions';

/** A workspace probe could not determine the compile-fixer's editable files. */
export class CompileFixerPlanFailed extends Schema.TaggedError<CompileFixerPlanFailed>()(
  'CompileFixerPlanFailed',
  { runId: RunIdSchema, message: Schema.String, cause: Schema.Defect() },
) {}

interface CompileFixerTarget {
  path: string;
  latexdiffArtifact?: LatexdiffArtifactSource;
  missingLatexdiffArtifact?: string;
}

/** How a compile fix is done, said in the first instruction of every
 *  conversation a host opens to fix one. */
export const COMPILE_FIX_RULES =
  'Keep edits minimal and in place: never rewrite or replace a workspace file wholesale, never change the mathematical content, never delete content to silence an error, and never invent a reference. Compile with `latexmk -pdf -interaction=nonstopmode <file>` to get a log (many undefined-reference and rerun messages need only a full rebuild), fix one issue at a time and recompile to confirm: errors first, then references, citations and hyperlinks, then warnings and bad boxes. If the failure comes from how the compile was invoked (working directory, `TEXINPUTS`, a file missing where it compiles) and not from the source, report that and stop. When done, summarize what changed.';

/** Resolve editable targets and a compile-fix conversation from one documents
 * projection, or `Rejected` with why it cannot run.
 * Model options are read by the caller before it captures the run's current documents.
 * The project root is explicit; only filesystem access comes from Effect context. */
export const planCompileFixer = Effect.fn('planCompileFixer')(
  function* (input: {
    readonly runId: RunId;
    readonly runConfig: AgentConfig | undefined;
    /** The run's rounds, as its documents fact records them; undefined
     *  for a run that is no document task's (it recorded no documents). */
    readonly rounds: readonly RoundOutput[] | undefined;
    readonly modelOptions: readonly Pick<
      ModelOptionData,
      'value' | 'availability'
    >[];
    readonly workspaceRoot: string | undefined;
  }): Effect.fn.Return<
    AgentConfigInput,
    Rejected | CompileFixerPlanFailed,
    FileSystem.FileSystem
  > {
    // The compile-fixer planner serves document tasks only.
    const { runConfig: savedTaskConfig, rounds } = input;
    if (!savedTaskConfig || rounds === undefined) {
      return yield* new Rejected({
        reason:
          'No document task found for this stream. Cannot fix its compile failures.',
      });
    }
    const compileFailures = rounds.flatMap(compileFailuresOf);

    if (compileFailures.length === 0) {
      return yield* new Rejected({
        reason: 'No compile failures are recorded for this stream.',
      });
    }

    const { decision } = decideLaunchModel(input.modelOptions, [
      { model: savedTaskConfig.model, reason: 'agent-config' },
    ]);
    if (!decision || decision._tag === 'Unavailable') {
      return yield* new Rejected({
        reason: 'No model is available to fix the compile failures.',
      });
    }
    if (decision._tag === 'Fallback')
      yield* Effect.logWarning(`compile fix: ${decision.notice}`).pipe(
        withLogChannel('CompileFixer'),
      );

    const model = decision.model;
    const targets = yield* compileFixerTargets(
      savedTaskConfig,
      compileFailures,
      rounds,
      input.workspaceRoot,
    ).pipe(
      Effect.mapError(
        (cause) =>
          new CompileFixerPlanFailed({
            runId: input.runId,
            message: toErrorMessage(cause),
            cause,
          }),
      ),
    );
    if (targets.length === 0) {
      return yield* new Rejected({
        reason:
          'No editable workspace file matched the compile failure. Accept the output into the workspace first, then fix the compile failures.',
      });
    }

    // The entry agent in a chat, not the task's program again.
    const {
      agentSource: _programSource,
      script: _program,
      ...taskConfig
    } = savedTaskConfig;
    return {
      ...taskConfig,
      ...entryAgent(),
      model,
      instruction: buildCompileFixerQuestion(
        compileFailures,
        targets,
        input.runId,
      ),
      inputFiles: targets.map((target) => target.path),
      outputFiles: [],
    };
  },
);

function buildCompileFixerQuestion(
  compileFailures: readonly CompileFailure[],
  targets: CompileFixerTarget[],
  runId: RunId,
): string {
  const runHint = `Run ID: ${runId}`;
  const editableFiles = targets.map((target) => target.path);
  const editableHint = `Editable workspace ${pluralize(editableFiles.length, 'target')}: ${editableFiles.join(', ')}`;
  const latexdiffLines = targets.flatMap((target) => {
    if (target.missingLatexdiffArtifact) {
      return `- ${target.missingLatexdiffArtifact} was a latexdiff artifact candidate, but it is not present in the workspace. ${target.path} is the inferred source fallback.`;
    }
    const artifact = target.latexdiffArtifact;
    return artifact ? `- ${latexdiffArtifactNote(target.path, artifact)}` : [];
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
    COMPILE_FIX_RULES,
    'If the failure is caused by a missing external dependency rather than editable LaTeX, report that clearly instead of inventing the missing file.',
  ]
    .filter(Boolean)
    .join('\n');
}

const compileFixerTargets = Effect.fn('compileFixer.targets')(function* (
  originalConfig: AgentConfig,
  compileFailures: readonly CompileFailure[],
  rounds: readonly RoundOutput[],
  workspaceRoot: string | undefined,
): Effect.fn.Return<
  CompileFixerTarget[],
  PlatformError.PlatformError,
  FileSystem.FileSystem
> {
  if (!workspaceRoot) return [];
  // Prefer the recorded output source, followed by the original inputs.
  const outputByPath = new Map(
    rounds
      .flatMap((round) => round.outputs)
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
        : compileFixerTargetsForCandidate(location.relativePath, workspaceRoot);
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
});

const compileFixerTargetsForCandidate = Effect.fn(
  'compileFixer.targetsForCandidate',
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
  const artifact = yield* latexdiffArtifactSource(relativePath, workspaceRoot);
  if (!artifact) {
    return (yield* exists(relativePath)) ? [{ path: relativePath }] : [];
  }

  const { sourcePath, sourceExists } = artifact;
  if (!(yield* exists(relativePath))) {
    return sourceExists
      ? [{ path: sourcePath, missingLatexdiffArtifact: relativePath }]
      : [];
  }

  const targets: CompileFixerTarget[] = [
    {
      path: relativePath,
      latexdiffArtifact: artifact,
    },
  ];
  if (sourceExists) {
    targets.push({ path: sourcePath });
  }
  return targets;
});
