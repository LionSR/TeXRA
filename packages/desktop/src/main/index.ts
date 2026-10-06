import { resolve as resolvePath } from 'node:path';
import { Cause, Effect, Exit, Scope } from 'effect';
import { app, BrowserWindow, dialog, session } from 'electron';

import { closeAllSessions } from '@agent/runtime';
import { HostDraftRequests } from '@controllers/session/hostDraftRequests';
import { disposeProcessRuntime } from '@controllers/session/sessionLayer';
import { NotificationFailed } from '@hosts/uiHosts';
import { withProcessServices } from '@platform/processRuntime';
import { telemetryNoticeIfDue } from '@telemetry/telemetryNotice';
import { ensureError, toErrorMessage } from '@utils/errors/errorMessage';
import {
  DesktopProjectRecords,
  openDesktopProjectRecords,
} from './desktopProjectRecords.js';
import {
  DesktopAttentionPort,
  electronAttentionPort,
  followDesktopAttention,
} from './desktopAttention.js';
import { removeExternalDiffPatchDirs } from './desktopDiffHost.js';
import {
  DesktopProjects,
  openDesktopProjectRegistry,
  readRememberedDesktopProjects,
  type DesktopProjectRegistry,
} from './desktopProjects.js';
import { openDesktopWindow } from './desktopWindow.js';
import { installDesktopBeforeQuitWiring } from './desktopWindowLifecycle.js';
import { createDesktopWindows, type DesktopWindows } from './desktopWindows.js';
import { reportFatalStartupError } from './fatalStartupError.js';
import { DESKTOP_HEADLESS } from './desktopPresentation.js';
import { initializeElectronPlatform } from './platform/index.js';
import { showDesktopWarningDialog } from './platform/warningDialog.js';

const moduleDirname = import.meta.dirname;
if (DESKTOP_HEADLESS && process.platform === 'darwin')
  app.setActivationPolicy('accessory');
// Playwright tests need a deterministic Electron profile so app-scoped stores
// survive across launches. Normal desktop launches keep Electron's default
// userData path.
const e2eUserDataPath = process.env.TEXRA_DESKTOP_E2E_USER_DATA_PATH;
if (e2eUserDataPath) {
  app.setPath('userData', resolvePath(e2eUserDataPath));
}

/**
 * The process's windows, once the startup program has built them. A second
 * launch can land before the process runtime exists, so the handler below
 * reads this at the event and finds nothing to focus until then.
 */
let desktopWindows: DesktopWindows | undefined;

// One desktop process per profile: a second launch focuses the running window
// and quits itself.
const ownsSingleInstanceLock = app.requestSingleInstanceLock();
if (ownsSingleInstanceLock) {
  app.on('second-instance', () => desktopWindows?.focus());
} else {
  app.quit();
}

// The packaged renderer uses Lit style attributes and bundled font data URLs
// (codicons/KaTeX). Keep script run locked to app files while allowing
// those renderer primitives.
const PRODUCTION_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "img-src 'self' data: blob:",
  "connect-src 'self' data:",
].join('; ');
const DEVELOPMENT_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "img-src 'self' data: blob:",
  "connect-src 'self' data: ws://localhost:* ws://127.0.0.1:* http://localhost:* http://127.0.0.1:*",
].join('; ');

function installContentSecurityPolicy(): void {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          app.isPackaged ? PRODUCTION_CSP : DEVELOPMENT_CSP,
        ],
      },
    });
  });
}

if (ownsSingleInstanceLock) {
  // The desktop entry: one program from Electron's `whenReady` to the wired
  // window. Its fatal report is the one fold, and it runs on the default
  // runner because it is what builds the process runtime.
  void Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise({
        try: () => app.whenReady(),
        catch: ensureError,
      });
      // Opened by the startup program below; a startup that fails before it
      // runs the shutdown handlers that read it.
      let projects: DesktopProjectRegistry | undefined;
      // The shutdown handlers, the startup program, and every surface they
      // wire run on the process runtime the platform builds.
      const { runtime, processScope, initialize } =
        yield* initializeElectronPlatform(moduleDirname);
      // Recording has one process owner, shared by every project and window.
      const draftRequests = new HostDraftRequests();
      // The process's shutdown is this scope's close. Its finalizers run in
      // the reverse of their registration: the window releases everything it
      // held (awaited), every session closes (its runs stopped and settled,
      // its artifacts flushed), the recording stops, the external-editor patch
      // directories every window's diff host recorded are removed, every
      // project is released (or, before the registry opened, the fallback
      // project's scope), and the runtime goes last.
      const shutdownScope = Scope.makeUnsafe();
      const shutdown = yield* Effect.cached(
        Scope.close(shutdownScope, Exit.void),
      );
      const reported = (what: string, step: Effect.Effect<void, Error>) =>
        step.pipe(
          Effect.catchCause((cause) =>
            Effect.sync(() =>
              console.error(`Shutdown: ${what} failed`, Cause.squash(cause)),
            ),
          ),
        );
      yield* Scope.addFinalizer(shutdownScope, disposeProcessRuntime(runtime));
      yield* Scope.addFinalizer(
        shutdownScope,
        Effect.suspend(
          () => projects?.dispose() ?? Scope.close(processScope, Exit.void),
        ),
      );
      yield* Scope.addFinalizer(
        shutdownScope,
        reported(
          'removing the external-editor patch directories',
          withProcessServices(runtime, removeExternalDiffPatchDirs),
        ),
      );
      yield* Scope.addFinalizer(
        shutdownScope,
        reported('stopping the active recording', draftRequests.shutdown),
      );
      yield* Scope.addFinalizer(shutdownScope, closeAllSessions());
      // Registered last, so it runs first: the sessions never close under a
      // window still tearing down.
      yield* Scope.addFinalizer(
        shutdownScope,
        Effect.suspend(() => desktopWindows?.released ?? Effect.void),
      );

      // Until the initial window is fully wired, any startup failure (platform
      // init included) runs the shutdown an ordinary application exit does.
      // Once this program completes, the lifecycle owns that cleanup. The
      // original failure is re-raised, not wrapped: the fatal report below
      // prints `error.stack` from the `Cause.squash`'d error.
      yield* withProcessServices(
        runtime,
        Effect.gen(function* () {
          const platformInit = yield* initialize;
          const projectRecords = yield* openDesktopProjectRecords;
          // Reopen every folder left open last time and show the one shown
          // last. A folder that is gone or no longer opens is reported once the
          // window exists; the others open regardless. Read before the
          // registry opens, so the recent list it starts from is pruned too.
          const remembered = yield* readRememberedDesktopProjects().pipe(
            Effect.provideService(DesktopProjectRecords, projectRecords),
          );
          const registry = yield* openDesktopProjectRegistry({
            dataRoot: platformInit.dataRoot,
            processRoots: platformInit.processRoots,
            processScope,
            globalConfigStore: platformInit.globalConfigStore,
            stores: {
              ...platformInit.processRoots,
              secrets: platformInit.secrets,
            },
          }).pipe(Effect.provideService(DesktopProjectRecords, projectRecords));
          projects = registry;
          const unopenedProjects = remembered.missing.map(
            (root) => `${root} (no such folder; forgotten)`,
          );
          yield* Effect.forEach(
            remembered.roots,
            (root) =>
              registry.open(root).pipe(
                Effect.catch((error) =>
                  Effect.sync(() => {
                    unopenedProjects.push(`${root}: ${toErrorMessage(error)}`);
                  }),
                ),
              ),
            { discard: true },
          );
          yield* registry.activate(registry.list().at(-1)?.root);

          installContentSecurityPolicy();
          const windows = createDesktopWindows({
            runtime,
            open: (hooks) =>
              openDesktopWindow(
                {
                  projects: registry,
                  draftRequests,
                  globalState: platformInit.globalState,
                  secrets: platformInit.secrets,
                  agentDirectories: platformInit.agentDirectories,
                  resourcesPath: platformInit.resourcesPath,
                  mainDir: platformInit.mainDir,
                  runtime,
                },
                hooks,
              ),
          });
          desktopWindows = windows;
          // Ask the renderer to close before draining process services. A dirty
          // editor can veto that close and remain fully operational. Once the
          // window really closes, its handler calls app.quit() again and this
          // listener proceeds with the ordinary shutdown chain.
          installDesktopBeforeQuitWiring({
            app,
            getMainWindow: windows.window,
            shutdown,
            continueAfterWindowClose: windows.continueQuitAfterClose,
          });
          yield* windows.open;
          // The one-time telemetry notice, shown once the window exists.
          const notice = yield* telemetryNoticeIfDue(
            platformInit.processRoots.config,
          );
          if (notice) {
            // A sheet on the window, not an app-modal box: an app-modal one on
            // a fresh profile keeps the first window from appearing.
            const parent = windows.window();
            void (parent
              ? dialog.showMessageBox(parent, { type: 'info', message: notice })
              : dialog.showMessageBox({ type: 'info', message: notice }));
          }
          app.on('activate', () => {
            if (BrowserWindow.getAllWindows().length === 0) windows.reopen();
          });
          // For the process lifetime: the fallback project's scope is the
          // last the shutdown releases.
          yield* followDesktopAttention.pipe(
            Effect.provideService(DesktopProjects, registry),
            Effect.provideService(
              DesktopAttentionPort,
              electronAttentionPort({
                window: windows.window,
                reveal: (key, runId) =>
                  windows.focus(() => windows.revealRun(key, runId)),
              }),
            ),
            Effect.catchCause((cause) =>
              Effect.logWarning(
                'The dock badge and notifications stopped following the projects',
                cause,
              ),
            ),
            Effect.forkIn(processScope),
          );
          if (unopenedProjects.length > 0) {
            // Forked: startup does not wait on the user dismissing it; the
            // process scope's close ends it with everything else.
            yield* Effect.tryPromise({
              try: () =>
                showDesktopWarningDialog(
                  `Some projects could not be reopened:\n${unopenedProjects.join('\n')}`,
                ),
              catch: (cause) =>
                new NotificationFailed({
                  member: 'showWarningMessage',
                  message: 'The unopened-projects warning could not be shown.',
                  cause,
                }),
            }).pipe(
              // Its failure or a defect: forked, nothing else reports it.
              // The scope's close interrupts it; that is not a failure.
              Effect.catchCause((cause) =>
                Cause.hasInterruptsOnly(cause)
                  ? Effect.void
                  : Effect.sync(() => console.error(Cause.squash(cause))),
              ),
              Effect.forkIn(processScope),
            );
          }
        }),
      ).pipe(Effect.onError(() => shutdown));
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.sync(() => reportFatalStartupError(Cause.squash(cause))),
      ),
    ),
  );
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
