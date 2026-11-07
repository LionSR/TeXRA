/**
 * The latexdiff verbs both GUI hosts answer through their window
 * (`openGuiWindow`): a diff of two files, the commit verbs (latexdiff-vc and
 * the pack and clean of what it produced), and the diffs of a whole run: the
 * ones its rounds recorded, and a fresh latexdiff for a round that recorded
 * none. The guards, the refusal wording and the outcome notices live here
 * once; a host supplies only how a generated diff opens and how a long diff
 * run shows its progress ({@link LatexdiffHost}).
 */

// Node imports
import * as path from 'node:path';

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
import type { HostRequest } from '@texra/shared/session/hostRequest';
import { DocumentsStateKey } from '@texra/shared/settingsView/documentsSettings';
import { documentsOf } from '@texra/shared/plugins/documents';
import { roundIndexedEntries } from '@texra/shared/plugins/documentOutputs';
import { getSafeDocumentRelativePath } from '@texra/utils/files/outputFileUtils';

// Local file imports
import { latexdiff, latexdiffAgainstCommit } from '../latexdiff';
import { LATEX_COMMANDS_CHANNEL as CHANNEL } from '../latexLogging';
import { latexdiffPairs } from './diffOperations';

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

/** The host's progress indicator, which VS Code's `vscode.Progress`
 *  satisfies structurally. */
interface ProgressReporter {
  report(value: { message?: string; increment?: number }): void;
}

/** What a host does for the latexdiff verbs. */
export interface LatexdiffHost {
  /** Open the generated diffs, in order, for viewing. */
  openDiffs(diffPaths: readonly string[]): LatexdiffVerb<void>;
  /** Run `task` under the host's progress indicator, titled `title`. */
  withProgress<A, E, R>(
    title: string,
    task: (progress: ProgressReporter) => Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R>;
}

/** The latexdiff verbs of one window, over its host's ports. */
export function latexdiffVerbs(parts: {
  readonly host: LatexdiffHost;
  readonly roots: WorkspaceRoots;
  /** The window's session: its view holds the runs' recorded documents. */
  readonly session: Session;
  readonly messages: Pick<
    MessageHost,
    'showInfoMessage' | 'showWarningMessage'
  >;
}) {
  const { host, roots, session, messages } = parts;
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
  const open = <E extends Error, R>(diff: Effect.Effect<string, E, R>) =>
    diff.pipe(
      Effect.mapError((error) => new Rejected({ reason: error.message })),
      Effect.flatMap((diffPath) => host.openDiffs([diffPath])),
    );

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
    yield* open(
      latexdiff(at(baseFile), at(editedFile), {
        roots,
        cwd: roots.workspace,
        suffix: '_diff',
      }),
    );
  }, withLogChannel(CHANNEL));

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
      return yield* open(latexdiffAgainstCommit(at(baseFile), commit, roots));
    }
    const message = latexdiffPackMessage(
      yield* runPackLatexdiffvc(
        baseFile,
        commit,
        action === 'cleanLatexdiffvc',
      ),
    );
    if (message) yield* notify(messages.showInfoMessage(message));
  }, withLogChannel(CHANNEL));

  /**
   * The latexdiffs of a whole run, opened: first each round's diffs as its
   * `document_diff` recorded them, then for each round with outputs and no
   * recorded diff, a latexdiff of the pairs it calls for. A run whose every
   * diff failed is refused.
   */
  const run = Effect.fn('latexdiffVerbs.run')(function* (runId: RunId) {
    const documents = documentsOf(
      session.view.current().runs.get(runId) ?? { facts: {} },
    );
    const recorded = Object.values(documents.latexdiffs).flat();
    const unrecorded = roundIndexedEntries(documents.files).filter(
      ([round]) => documents.latexdiffs[round] === undefined,
    );
    const betweenRounds =
      unrecorded.length > 0 &&
      (yield* Settings.get<boolean>(
        roots,
        DocumentsStateKey.LATEXDIFF_BETWEEN_ROUNDS,
      ).pipe(Effect.mapError((cause) => hostFailure('runLatexdiff', cause))));
    const pairs = unrecorded.flatMap(([round, outputs]) =>
      latexdiffPairs(
        outputs,
        betweenRounds ? (documents.files[round - 1] ?? []) : [],
      ),
    );
    // Extraction records every output's lineage; one with no base in it is a
    // new document, not a failure. An output whose lineage was never recorded
    // lacks a base the run could have named: it counts as a failed diff.
    const missingLineage = unrecorded.flatMap(([round, outputs]) =>
      outputs
        .filter((info) => info.lineage === null)
        .map(
          (info) => `${getSafeDocumentRelativePath(info.source)} (r${round})`,
        ),
    );
    for (const description of missingLineage) {
      yield* Effect.logWarning(
        `Diff skipped (${description}): its lineage was never recorded`,
      );
    }
    const total = recorded.length + pairs.length + missingLineage.length;
    if (total === 0) {
      yield* notify(
        messages.showInfoMessage(
          'No LaTeX diff operations available for this run.',
        ),
      );
      return;
    }

    // Sequential: each latexdiff is a whole TeX run, narrated one at a time.
    const diffPairs = (progress: ProgressReporter) =>
      Effect.forEach(
        pairs,
        ({ revised, document, base, baseRound, suffix }) => {
          const description =
            baseRound === null
              ? `${document} (r${revised.round})`
              : `${document} (r${baseRound}→r${revised.round})`;
          progress.report({
            increment: 100 / pairs.length,
            message: `Running diff for ${description}`,
          });
          return latexdiff(base, revised.location, {
            roots,
            // A diff runs in its base file's folder when no folder is open.
            cwd: roots.workspace ?? path.dirname(base.absolutePath),
            suffix,
          }).pipe(
            Effect.map((diffPath): readonly string[] => [diffPath]),
            Effect.catch((error) =>
              Effect.logWarning(
                `Diff failed (${description}): ${error.message}`,
              ).pipe(Effect.as([])),
            ),
          );
        },
      );
    const fresh =
      pairs.length === 0
        ? []
        : yield* host.withProgress('Running LaTeX diffs', diffPairs);
    const diffPaths = [
      ...recorded.flatMap((entry) =>
        entry.status === 'ok' ? [entry.diff.absolutePath] : [],
      ),
      ...fresh.flat(),
    ];

    if (diffPaths.length === 0) {
      return yield* new Rejected({
        reason: 'All LaTeX diff operations failed',
      });
    }
    yield* notify(
      diffPaths.length < total
        ? messages.showWarningMessage(
            `${diffPaths.length} of ${total} LaTeX diff operations completed successfully`,
          )
        : messages.showInfoMessage('All LaTeX diffs completed successfully'),
    );
    yield* host.openDiffs(diffPaths);
  }, withLogChannel(CHANNEL));

  return { file, againstCommit, run };
}
