// Third-party imports
import { Cause, Effect, FileSystem } from 'effect';
import * as vscode from 'vscode';

// Local imports
import type { SessionHandle } from '@agent/runtime';
import { createLatexRunDiscovery } from '@agent/storage';
import { registerCommandEntries } from '@commands/_shared/registerCommands';
import {
  prepareBuildDisplay,
  scheduleViewerDisplay,
} from '@frontend/latex/openBuild';
import {
  showLoggedErrorMessage,
  showLoggedInfoMessage,
  showLoggedMessage,
  showLoggedMessageWithDocs,
} from '@frontend/ui/errorHandlingUtils';
import { withVSCodeProgress } from '@frontend/ui/progress';
import {
  latexdiffPackMessage,
  runPackLatexdiffvc,
} from '@housekeeping/packLatexdiffvc';
import { LaTeXdiffService, type LaTeXdiffResult } from '@latex/latexdiff';
import { LATEX_COMMANDS_CHANNEL as CHANNEL } from '@latex/latexLogging';
import type {
  DiffRunResult,
  RunLatexdiffCommandConfig,
} from '@latex/latexdiff/types';
import {
  normalizeRunLatexdiffOutputsByRound,
  runLatexdiffForRun,
} from '@latex/latexdiff/runLatexdiff';
import {
  latexdiffAllFailedMessage,
  NO_LATEXDIFF_OPERATIONS_MESSAGE,
} from '@latex/latexdiff/latexdiffCopy';
import { withLogChannel } from '@logger/effectLog';
import type { ProcessRuntime } from '@platform/processRuntime';
import { withSessionFs } from '@platform/rootedFs';
import type { FileLocation } from '@shared/schemas';
import { WorkspaceStateKey } from '@shared/state/stateKeys';
import { settingByKey, settingEnumChoices } from '@shared/state/stateSettings';
import type { LatexdiffMathMarkupValue } from '@shared/constants/latexConfig';
import { readSettingFrom } from '@utils/config/platformSettings';
import { ensureError, toErrorMessage } from '@utils/errors/errorMessage';
import { pathToLocationIn } from '@utils/files/fileLocation';
import { entryExists } from '@utils/files/fsEntryExists';
import { checkToolInstalled } from '@utils/system/toolUtils';
import type { ChildProcessSpawner } from 'effect/unstable/process/ChildProcessSpawner';

type LatexdiffTool = 'latexdiff' | 'latexdiff-vc';

/**
 * Run a latexdiff command body, skipping it when the tool is missing and
 * reporting any failure under `errorMessage`: every command in this file goes
 * through this one terminal boundary. `catchCause` answers a typed failure and
 * a defect alike through `Cause.squash`; an interrupt is re-raised (#12841).
 */
const withLatexdiffTool = <E, R>(
  tool: LatexdiffTool,
  errorMessage: string,
  action: Effect.Effect<void, E, R>,
): Effect.Effect<void, never, R | ChildProcessSpawner> =>
  Effect.gen(function* () {
    const installed = yield* checkToolInstalled(tool);
    if (!installed) {
      yield* Effect.logWarning(`${tool} is not installed; skipping.`);
      return;
    }
    yield* action;
  }).pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.interrupt
        : showLoggedErrorMessage(
            CHANNEL,
            errorMessage,
            Cause.squash(cause),
          ).pipe(Effect.asVoid),
    ),
    // Every log in a command body belongs to this file's channel.
    withLogChannel(CHANNEL),
  );

type MarkupItem = vscode.QuickPickItem & { value: LatexdiffMathMarkupValue };

// Returns undefined when the user cancels, logging it so callers just bail.
const promptForLatexdiffMathMarkup = Effect.fnUntraced(function* (
  session: SessionHandle,
) {
  const configuredMode = yield* readSettingFrom<LatexdiffMathMarkupValue>(
    session.roots,
    WorkspaceStateKey.LATEXDIFF_MATH_MARKUP,
  );
  // The row is a catalog enum row: a missing one is a defect, not an option.
  const items: MarkupItem[] = settingEnumChoices<LatexdiffMathMarkupValue>(
    settingByKey(WorkspaceStateKey.LATEXDIFF_MATH_MARKUP)!,
  )!.map(({ value, label, description }) => ({
    label,
    description,
    picked: value === configuredMode,
    value,
  }));
  // Keep the configured mode first so Enter accepts it immediately.
  const prioritizedItems = [
    ...items.filter((item) => item.value === configuredMode),
    ...items.filter((item) => item.value !== configuredMode),
  ];

  const pick = yield* Effect.tryPromise({
    try: () =>
      Promise.resolve(
        vscode.window.showQuickPick<MarkupItem>(prioritizedItems, {
          title: 'Latexdiff math markup',
          placeHolder: 'Select math markup granularity for this diff run',
          ignoreFocusOut: true,
          prompt: `Saved default: ${configuredMode} — press Enter to accept, or pick another`,
        }),
      ),
    catch: ensureError,
  });
  if (!pick) {
    yield* Effect.logDebug('Math markup selection cancelled by user');
  }
  return pick?.value;
});

interface OpenedLatexdiffResult {
  diffLocation: FileLocation;
  viewerReady: boolean;
}

/**
 * Open and build one generated diff, returning its resolved location and
 * whether the viewer may be scheduled for it. A generated path alone is not
 * enough: an external `compileLatex2Pdf` failure can produce a generated
 * file whose PDF is not viewer-ready.
 */
const openLatexdiffResult = Effect.fnUntraced(function* (
  session: SessionHandle,
  diffFilePath: string,
  options: { scheduleViewer?: boolean } = {},
) {
  const diffLocation = pathToLocationIn(session.roots.workspace, diffFilePath);
  const fs = yield* FileSystem.FileSystem;

  if (!(yield* entryExists(fs, diffLocation.absolutePath))) {
    yield* showLoggedMessage(
      CHANNEL,
      `Diff file could not be found. Expected path: ${diffFilePath}`,
    );
    return undefined;
  }

  // The file-open/build phase stays a settled step so multi-round latexdiff
  // runs keep their sequential build/show ordering and failures still reach
  // the command's report. The caller decides whether to schedule a viewer
  // from `viewerReady`; a generated path alone is not enough when external
  // compilation failed (#10553).
  const viewerReady = yield* prepareBuildDisplay(session, diffLocation, {
    preserveFocus: true,
    scheduleViewer: options.scheduleViewer,
  });
  return { diffLocation, viewerReady } satisfies OpenedLatexdiffResult;
});

/**
 * Restore the last successfully prepared diff as the active LaTeX document
 * before scheduling the argument-free viewer. Used whenever a later processed
 * diff changed LaTeX Workshop's current document/root but is not the intended
 * viewer target (either a later setup rejected, or the last processed diff was
 * not viewer-ready).
 */
const restorePreparedViewerTarget = (
  diffLocation: FileLocation,
): Effect.Effect<boolean> =>
  Effect.tryPromise({
    try: async () => {
      const doc = await vscode.workspace.openTextDocument(
        vscode.Uri.file(diffLocation.absolutePath),
      );
      await vscode.window.showTextDocument(doc, {
        preview: true,
        preserveFocus: true,
      });
      return true;
    },
    catch: ensureError,
  }).pipe(
    // The original setup error still propagates; a failed restore is a reason
    // to skip the argument-free viewer rather than open a stale/unrelated PDF.
    Effect.catch((err) =>
      Effect.logWarning(
        `Failed to restore the last prepared diff before viewer handoff: ${toErrorMessage(err)}`,
      ).pipe(Effect.as(false)),
    ),
  );

/**
 * Prepare every successful diff in result order and schedule exactly one
 * detached viewer handoff for the last viewer-ready diff.
 *
 * Each file-open/build phase stays settled and serialized, so setup failures
 * reach `withLatexdiffTool`. The viewer is restored to the last viewer-ready
 * diff whenever a later processed diff is not viewer-ready, including on
 * normal completion (#10553) — the handoff is an `ensuring` finalizer, so it
 * runs on the failing path exactly as the `finally` it replaces did.
 */
const prepareLatexdiffResultsAndScheduleViewer = Effect.fnUntraced(function* (
  session: SessionHandle,
  results: readonly DiffRunResult[],
) {
  let lastViewerLocation: FileLocation | undefined;
  let lastProcessedLocation: FileLocation | undefined;
  let completedSetup = false;

  yield* Effect.gen(function* () {
    for (const result of results) {
      const suffix = result.description ? ` (${result.description})` : '';

      if (result.success) {
        const opened = yield* openLatexdiffResult(session, result.diffPath, {
          scheduleViewer: false,
        });
        if (opened) {
          lastProcessedLocation = opened.diffLocation;
          yield* Effect.logDebug(`Generated diff: ${result.diffPath}${suffix}`);
          if (opened.viewerReady) {
            lastViewerLocation = opened.diffLocation;
          }
        }
      } else {
        yield* Effect.logWarning(`Diff failed${suffix}: ${result.message}`);
      }
    }
    completedSetup = true;
  }).pipe(
    Effect.ensuring(
      Effect.gen(function* () {
        if (!lastViewerLocation) return;
        let viewerTargetReady = true;
        if (
          !completedSetup ||
          lastProcessedLocation?.absolutePath !==
            lastViewerLocation.absolutePath
        ) {
          viewerTargetReady =
            yield* restorePreparedViewerTarget(lastViewerLocation);
        }
        if (viewerTargetReady) {
          // Detached: the viewer confirmation fires long after this finalizer
          // returns, exactly as the fork on the entry's runtime did.
          yield* Effect.forkDetach(scheduleViewerDisplay, {
            startImmediately: true,
          });
        }
      }),
    ),
  );
});

/**
 * Prompt for math markup, run a diff, and open the generated diff file. Shared
 * by the `latexdiff` and `latexdiff-vc` entry points, which differ only in the
 * underlying diff call and the tool name used for logging.
 */
const runDiffAndOpen = Effect.fnUntraced(function* (
  session: SessionHandle,
  toolLabel: string,
  runDiff: (
    mathMarkup: LatexdiffMathMarkupValue,
  ) => Effect.Effect<
    LaTeXdiffResult,
    never,
    FileSystem.FileSystem | ChildProcessSpawner
  >,
) {
  const mathMarkup = yield* promptForLatexdiffMathMarkup(session);
  if (!mathMarkup) return;
  yield* Effect.logInfo(`Running ${toolLabel}, math markup: ${mathMarkup}`);

  const result = yield* runDiff(mathMarkup);
  if (!result.success) {
    // The service answers every diff outcome as a value, so a failed diff
    // reaches the report through the failure channel carrying its own
    // message — the text `formatError` prefixed before.
    return yield* Effect.fail(new Error(result.message));
  }
  yield* openLatexdiffResult(session, result.diffPath);
});

/**
 * The file a latexdiff run compares against: the picked base file, falling
 * back to the primary input the webview sends beside it. Both arrive as bare
 * `z.string()` wire fields and clearing the base picker writes `''`, so `||`
 * — not `??` — is what makes the fallback the producer already pays for
 * actually fire. Reports once and returns undefined when neither is set.
 */
const resolveDiffBase = Effect.fnUntraced(function* (
  inputFile: string,
  baseFile: string,
) {
  const fileToUse = baseFile || inputFile;
  if (fileToUse) return fileToUse;
  yield* showLoggedMessageWithDocs(
    CHANNEL,
    'No base file specified for latexdiff',
    'latex-diff',
    'Latexdiff Docs',
  );
  return undefined;
});

const handleLatexdiff = Effect.fnUntraced(function* (
  session: SessionHandle,
  inputFile: string,
  baseFile: string,
  editedFile: string,
) {
  const fileToUse = yield* resolveDiffBase(inputFile, baseFile);
  if (!fileToUse) return;
  if (!editedFile) {
    yield* showLoggedMessageWithDocs(
      CHANNEL,
      'No revised file specified for latexdiff',
      'latex-diff',
      'Latexdiff Docs',
    );
    return;
  }

  yield* withLatexdiffTool(
    'latexdiff',
    'Error creating LaTeX diff',
    runDiffAndOpen(session, 'latexdiff', (mathMarkup) =>
      new LaTeXdiffService(CHANNEL, session.roots).runDiff(
        pathToLocationIn(session.roots.workspace, fileToUse),
        pathToLocationIn(session.roots.workspace, editedFile),
        '_diff',
        mathMarkup,
        { cwd: session.roots.workspace },
      ),
    ),
  );
});

const handleLatexdiffvc = Effect.fnUntraced(function* (
  session: SessionHandle,
  inputFile: string,
  baseFile: string,
  commitHash: string,
) {
  const fileToUse = yield* resolveDiffBase(inputFile, baseFile);
  if (!fileToUse) return;
  yield* withLatexdiffTool(
    'latexdiff-vc',
    'Error creating LaTeX diff',
    runDiffAndOpen(session, 'latexdiff-vc', (mathMarkup) =>
      new LaTeXdiffService(CHANNEL, session.roots).runDiffVc(
        pathToLocationIn(session.roots.workspace, fileToUse),
        commitHash,
        mathMarkup,
      ),
    ),
  );
});

const handlePackLatexdiffvc = Effect.fnUntraced(function* (
  session: SessionHandle,
  inputFile: string,
  baseFile: string,
  commitHash: string,
  clean: boolean,
) {
  yield* withLatexdiffTool(
    'latexdiff-vc',
    clean ? 'Error cleaning LaTeX diff' : 'Error packing LaTeX diff',
    Effect.gen(function* () {
      yield* Effect.logDebug(
        `Command called with: inputFile=${inputFile}, baseFile=${baseFile}, commitHash=${commitHash}, clean=${clean}`,
      );
      const fileToUse = yield* resolveDiffBase(inputFile, baseFile);
      if (!fileToUse) return;
      // The pack run is a step of this program, over the session's rooted
      // filesystems, rather than a nested settle on the entry's runtime.
      const result = yield* withSessionFs(
        session.roots,
        runPackLatexdiffvc(fileToUse, commitHash, clean),
      );
      const message = latexdiffPackMessage(result);
      if (message) {
        yield* Effect.forkDetach(showLoggedInfoMessage(CHANNEL, message));
      }
    }),
  );
});

const handleRunLatexdiff = Effect.fnUntraced(function* (
  session: SessionHandle,
  config: RunLatexdiffCommandConfig,
) {
  yield* withLatexdiffTool(
    'latexdiff',
    'Error running LaTeX diffs',
    Effect.gen(function* () {
      yield* Effect.logDebug(`Command config: ${JSON.stringify(config)}`);

      const { agent, model, inputFile } = config;

      if (!agent || !model || !inputFile) {
        yield* showLoggedMessage(
          CHANNEL,
          'Missing required configuration parameters',
        );
        return;
      }

      const mathMarkup = yield* promptForLatexdiffMathMarkup(session);
      if (!mathMarkup) return;

      yield* Effect.logInfo(`Running latexdiff, math markup: ${mathMarkup}`);

      const generateBetweenRoundDiffs = yield* readSettingFrom<boolean>(
        session.roots,
        WorkspaceStateKey.LATEXDIFF_BETWEEN_ROUNDS,
      );
      yield* Effect.logDebug(`Between rounds: ${generateBetweenRoundDiffs}`);

      const outputsByRound = normalizeRunLatexdiffOutputsByRound(
        config.outputsByRound,
      );

      const { outcome } = yield* withVSCodeProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Running LaTeX diffs',
          cancellable: false,
        },
        (progress) => {
          progress.report({
            increment: 0,
            message: 'Preparing LaTeX diffs...',
          });
          return runLatexdiffForRun({
            ...config,
            workspaceRoot: session.roots.workspace,
            storageRoot: session.roots.storage,
            outputsByRound,
            mathMarkup,
            generateBetweenRoundDiffs,
            runDiscovery: createLatexRunDiscovery(session),
            latexdiff: {
              channel: CHANNEL,
              service: new LaTeXdiffService(CHANNEL, session.roots),
            },
            progress,
          });
        },
      );

      const { results } = outcome;

      if (results.length === 0) {
        vscode.window.showInformationMessage(NO_LATEXDIFF_OPERATIONS_MESSAGE);
        return;
      }

      const successCount = results.filter((r) => r.success).length;

      if (successCount === 0) {
        yield* showLoggedMessage(
          CHANNEL,
          latexdiffAllFailedMessage(mathMarkup),
        );
      } else if (successCount < results.length) {
        vscode.window.showWarningMessage(
          `${successCount} of ${results.length} LaTeX diff operations completed successfully (math markup: "${mathMarkup}")`,
        );
      } else {
        vscode.window.showInformationMessage(
          `All LaTeX diffs completed successfully (math markup: "${mathMarkup}")`,
        );
      }

      yield* prepareLatexdiffResultsAndScheduleViewer(session, results);
    }),
  );
});

export function registerLatexdiffCommands(
  context: vscode.ExtensionContext,
  runtime: ProcessRuntime,
  session: SessionHandle,
): void {
  registerCommandEntries(context, [
    {
      id: 'texra.latexdiff',
      handler: (inputFile: string, baseFile: string, editedFile: string) =>
        runtime.runPromise(
          handleLatexdiff(session, inputFile, baseFile, editedFile),
        ),
    },
    {
      id: 'texra.latexdiffvc',
      handler: (inputFile: string, baseFile: string, commitHash: string) =>
        runtime.runPromise(
          handleLatexdiffvc(session, inputFile, baseFile, commitHash),
        ),
    },
    {
      id: 'texra.packLatexdiffvc',
      handler: (
        inputFile: string,
        baseFile: string,
        commitHash: string,
        clean: boolean,
      ) =>
        runtime.runPromise(
          handlePackLatexdiffvc(
            session,
            inputFile,
            baseFile,
            commitHash,
            clean,
          ),
        ),
    },
    {
      id: 'texra.cleanLatexdiffvc',
      // Clean is a pack run with `clean` set, and the failure label follows it.
      handler: (inputFile: string, baseFile: string, commitHash: string) =>
        runtime.runPromise(
          handlePackLatexdiffvc(session, inputFile, baseFile, commitHash, true),
        ),
    },
    {
      id: 'texra.runLatexdiff',
      handler: (config: RunLatexdiffCommandConfig) =>
        runtime.runPromise(handleRunLatexdiff(session, config)),
    },
  ]);
}
