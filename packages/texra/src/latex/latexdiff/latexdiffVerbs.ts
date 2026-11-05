/**
 * The latexdiff verbs both GUI hosts answer through their window
 * (`openGuiWindow`): a diff of two files, the commit verbs (latexdiff-vc and
 * the pack and clean of what it produced), and the round-aware diff of a
 * whole run. The guards, the refusal wording and the outcome notices live
 * here once; a host supplies only how a generated diff opens and how a long
 * diff run shows its progress ({@link LatexdiffHost}).
 */

// Third-party imports
import { Effect } from 'effect';

// Local imports
import {
  Rejected,
  type HostRequestFailure,
  type Session,
  type WorkspaceRoots,
} from '@texra-ai/harness';
import {
  pathToLocationIn,
  Settings,
  withLogChannel,
  type ProcessServices,
  type StorageFs,
  type WorkspaceFs,
} from '@texra-ai/harness/host';
import type { RunId } from '@texra-ai/harness/schemas';
import { hostFailure } from '@texra/controllers/session/hostCallFailure';
import {
  latexdiffPackMessage,
  runPackLatexdiffvc,
} from '@housekeeping/packLatexdiffvc';
import type { MessageHost } from '@texra/hosts/uiHosts';
import type { LatexdiffMathMarkupValue } from '@texra/shared/constants/latexConfig';
import type { HostRequest } from '@texra/shared/session/hostRequest';
import { DocumentsStateKey } from '@texra/shared/settingsView/documentsSettings';
import { runOutputFiles } from '@texra/tools/documents/runOutputs';

// Local file imports
import { LaTeXdiffService, type LaTeXdiffResult } from '../latexdiff';
import { LATEX_COMMANDS_CHANNEL as CHANNEL } from '../latexLogging';
import {
  runLatexdiffForRun,
  type DiffProgressReporter,
} from './diffOperations';

/** The latexdiff verbs taken against a commit rather than an edited file. */
type LatexdiffCommitAction = Extract<
  Extract<HostRequest, { kind: 'latexdiffs' }>['action'],
  'latexdiffvc' | 'packLatexdiffvc' | 'cleanLatexdiffvc'
>;

/** A host verb, run on the fiber of the window's request dispatch. */
type LatexdiffVerb<A> = Effect.Effect<
  A,
  HostRequestFailure,
  ProcessServices | StorageFs | WorkspaceFs
>;

/** What a host does for the latexdiff verbs. */
export interface LatexdiffHost {
  /** Open the generated diffs, in order, for viewing. */
  openDiffs(diffPaths: readonly string[]): LatexdiffVerb<void>;
  /** Run `task` under the host's progress indicator, titled `title`. */
  withProgress<A, E, R>(
    title: string,
    task: (progress: DiffProgressReporter) => Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R>;
}

/** The latexdiff verbs of one window, over its host's ports. */
export function latexdiffVerbs(parts: {
  readonly host: LatexdiffHost;
  readonly roots: WorkspaceRoots;
  /** The window's session: its view holds the runs' recorded outputs. */
  readonly session: Session;
  readonly messages: Pick<
    MessageHost,
    'showInfoMessage' | 'showWarningMessage'
  >;
}) {
  const { host, roots, session, messages } = parts;
  const service = new LaTeXdiffService(CHANNEL, roots);
  const at = (file: string) => pathToLocationIn(roots.workspace, file);

  /** A notice the request does not wait on: a VS Code toast answers only
   *  when it is dismissed. */
  const notify = (notice: Effect.Effect<void, HostRequestFailure>) =>
    Effect.forkDetach(
      notice.pipe(
        Effect.catch((cause) =>
          Effect.logWarning('LaTeX diff notice failed', cause),
        ),
      ),
    );

  /** A generated diff opens; a failed one is refused with its message. */
  const openResult = (result: LaTeXdiffResult) =>
    result.success
      ? host.openDiffs([result.diffPath])
      : Effect.fail(new Rejected({ reason: result.message }));

  /** latexdiff over two files of the workspace. */
  const file = Effect.fn('latexdiffVerbs.file')(function* (
    baseFile: string,
    editedFile: string,
  ) {
    if (!baseFile || !editedFile) {
      return yield* new Rejected({
        reason: 'Choose a base file and an edited file first.',
      });
    }
    // The math markup is the executor's: it reads the setting.
    const result = yield* service.runDiff(
      at(baseFile),
      at(editedFile),
      '_diff',
      undefined,
      { cwd: roots.workspace },
    );
    yield* openResult(result);
  });

  /** latexdiff-vc over the base file against a commit, and the pack and
   *  clean housekeeping of what it produced. */
  const againstCommit = Effect.fn('latexdiffVerbs.againstCommit')(function* (
    action: LatexdiffCommitAction,
    baseFile: string,
    commit: string,
  ) {
    if (!baseFile) {
      return yield* new Rejected({ reason: 'Choose a base file first.' });
    }
    if (action === 'latexdiffvc') {
      return yield* openResult(yield* service.runDiffVc(at(baseFile), commit));
    }
    const message = latexdiffPackMessage(
      yield* runPackLatexdiffvc(
        baseFile,
        commit,
        action === 'cleanLatexdiffvc',
      ),
    );
    if (message) yield* notify(messages.showInfoMessage(message));
  });

  /** The round-aware latexdiff of a whole run, opening every diff it
   *  produced; a run whose every diff failed is refused. */
  const run = Effect.fn('latexdiffVerbs.run')(function* (runId: RunId) {
    // Read once, so the notices name the markup every diff ran with.
    const mathMarkup = yield* Settings.get<LatexdiffMathMarkupValue>(
      roots,
      DocumentsStateKey.LATEXDIFF_MATH_MARKUP,
    );
    yield* Effect.logInfo(`Running latexdiff, math markup: ${mathMarkup}`);
    const { results } = yield* host
      .withProgress('Running LaTeX diffs', (progress) => {
        progress.report({ increment: 0, message: 'Preparing LaTeX diffs...' });
        return runLatexdiffForRun({
          runId,
          rounds: runOutputFiles(session.view.current(), runId),
          roots,
          mathMarkup,
          channel: CHANNEL,
          progress,
        });
      })
      .pipe(Effect.mapError((cause) => hostFailure('runLatexdiff', cause)));
    if (results.length === 0) {
      yield* notify(
        messages.showInfoMessage(
          'No LaTeX diff operations available for this run.',
        ),
      );
      return;
    }
    const diffPaths: string[] = [];
    for (const result of results) {
      if (result.success) diffPaths.push(result.diffPath);
      else
        yield* Effect.logWarning(
          `Diff failed (${result.description}): ${result.message}`,
        );
    }
    if (diffPaths.length === 0) {
      return yield* new Rejected({
        reason: `All LaTeX diff operations failed (math markup: "${mathMarkup}")`,
      });
    }
    yield* notify(
      diffPaths.length < results.length
        ? messages.showWarningMessage(
            `${diffPaths.length} of ${results.length} LaTeX diff operations completed successfully (math markup: "${mathMarkup}")`,
          )
        : messages.showInfoMessage(
            `All LaTeX diffs completed successfully (math markup: "${mathMarkup}")`,
          ),
    );
    yield* host.openDiffs(diffPaths);
  }, withLogChannel(CHANNEL));

  return { file, againstCommit, run };
}
