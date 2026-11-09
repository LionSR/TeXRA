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
import { type Session, type WorkspaceRoots } from '@texra-ai/harness';
import { pathToLocationIn, type ProcessServices } from '@texra-ai/harness/host';
import {
  Settings,
  withLogChannel,
  type StorageFs,
  type WorkspaceFs,
} from '@texra-ai/harness/plugins';
import {
  Rejected,
  type RunId,
  type SettingRow,
} from '@texra-ai/harness/schemas';
import { hostFailure } from '@texra/controllers/session/hostCallFailure';
import {
  latexdiffPackMessage,
  runPackLatexdiffvc,
} from '@housekeeping/packLatexdiffvc';
import type { Dialogs, NoticeLevel } from '@texra/hosts/uiHosts';
import type { HostCommand } from '@texra/shared/session/hostRequest';
import { documentRoundsOf } from '@texra/shared/plugins/documents';
import { formatRoundLabel } from '@texra/shared/plugins/documentOutputs';

// Local file imports
import { latexdiff, latexdiffAgainstCommit } from '../latexdiff';
import { LATEX_COMMANDS_CHANNEL as CHANNEL } from '../latexLogging';
import { latexdiffPairs } from './diffOperations';
import { WORKSPACE_DIFF_SUFFIX } from './diffFileNameManager';
import { type HostCommandFailure } from '@texra/controllers/session/hostCallFailure';
import {
  LATEXDIFF_BETWEEN_ROUNDS_SETTING,
  LATEXDIFF_MATH_MARKUP_SETTING,
} from '@texra/shared/settingsView/documentsSettings';

/** The latexdiff verbs taken against a commit rather than an edited file. */
type LatexdiffCommitAction = Extract<
  Extract<HostCommand, { kind: 'latexdiffs' }>['action'],
  'latexdiffvc' | 'packLatexdiffvc' | 'cleanLatexdiffvc'
>;

/** A host verb, run on the fiber of the window's request dispatch. */
type LatexdiffVerb<A> = Effect.Effect<
  A,
  HostCommandFailure,
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
  readonly notify: Dialogs['notify'];
}) {
  const { host, roots, session } = parts;
  const at = (file: string) => pathToLocationIn(roots.workspace, file);

  /** A notice the request does not wait on: a VS Code toast answers only
   *  when it is dismissed. */
  const notify = (level: NoticeLevel, message: string) =>
    Effect.forkDetach(parts.notify(level, message));

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
        suffix: WORKSPACE_DIFF_SUFFIX,
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
    if (message) yield* notify('info', message);
  }, withLogChannel(CHANNEL));

  /**
   * The latexdiffs of a whole run, opened: first each round's diffs as its
   * `document_diff` recorded them, then for each round with outputs and no
   * recorded diff (or a failed one, or one made under another math markup
   * than the setting's now), a latexdiff of the pairs it calls for. A run
   * whose every diff failed is refused.
   */
  const run = Effect.fn('latexdiffVerbs.run')(function* (runId: RunId) {
    const rounds = documentRoundsOf(
      session.view.current().runs.get(runId) ?? { facts: {} },
    );
    const setting = <A>(row: SettingRow<A>) =>
      Settings.get(roots, row).pipe(
        Effect.mapError((cause) => hostFailure('runLatexdiff', cause)),
      );
    const mathMarkup = yield* setting(LATEXDIFF_MATH_MARKUP_SETTING);
    // A round whose recorded diffs all succeeded under the markup set now
    // opens them; a round that recorded none, a failed one, or one made
    // under another markup is diffed again.
    const reusable = rounds.map(
      ({ latexdiffs }) =>
        latexdiffs.length > 0 &&
        latexdiffs.every(
          (entry) => entry.status === 'ok' && entry.mathMarkup === mathMarkup,
        ),
    );
    const recorded = rounds.flatMap((round, i) =>
      reusable[i] ? round.latexdiffs : [],
    );
    const unrecorded = rounds.filter(
      (round, i) => !reusable[i] && round.outputs.length > 0,
    );
    const betweenRounds =
      unrecorded.length > 0 &&
      (yield* setting(LATEXDIFF_BETWEEN_ROUNDS_SETTING));
    const pairs = unrecorded.flatMap(({ round, outputs }) =>
      latexdiffPairs(
        outputs,
        betweenRounds
          ? (rounds.find((earlier) => earlier.round === round - 1)?.outputs ??
              [])
          : [],
      ),
    );
    const total = recorded.length + pairs.length;
    if (total === 0) {
      yield* notify('info', 'No LaTeX diff operations available for this run.');
      return;
    }

    // Sequential: each latexdiff is a whole TeX run, narrated one at a time.
    const diffPairs = (progress: ProgressReporter) =>
      Effect.forEach(
        pairs,
        ({ revised, document, base, baseRound, suffix }) => {
          const description =
            baseRound === null
              ? `${document} (${formatRoundLabel(revised.round)})`
              : `${document} (${formatRoundLabel(baseRound)} → ${formatRoundLabel(revised.round)})`;
          progress.report({
            increment: 100 / pairs.length,
            message: `Running diff for ${description}`,
          });
          return latexdiff(base, revised.location, {
            roots,
            // A diff runs in its base file's folder when no folder is open.
            cwd: roots.workspace ?? path.dirname(base.absolutePath),
            suffix,
            mathMarkup,
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
    yield* diffPaths.length < total
      ? notify(
          'warning',
          `${diffPaths.length} of ${total} LaTeX diff operations completed successfully`,
        )
      : notify('info', 'All LaTeX diffs completed successfully');
    yield* host.openDiffs(diffPaths);
  }, withLogChannel(CHANNEL));

  return { file, againstCommit, run };
}
