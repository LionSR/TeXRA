import { Cause, Effect, Exit, Scope } from 'effect';
import { app, BrowserWindow, session } from 'electron';

import { Sessions } from '@texra-ai/worldline';
import { GlobalValues } from '@texra-ai/worldline/plugins';
import { withProcessServices } from '@texra-ai/worldline/host';
import { toErrorMessage } from '@texra-ai/worldline/schemas';
import { telemetryNoticeIfDue } from '@telemetry/telemetryNotice';
import { HostDraftRequests } from '@texra/controllers/session/hostDraftRequests';
import { reachBundledService } from '@texra/controllers/server/client';
import {
  DesktopProjectRecords,
  openDesktopProjectRecords,
} from './desktopProjectRecords.js';
import {
  electronAttentionPort,
  followDesktopAttention,
} from './desktopAttention.js';
import {
  openDesktopProjectRegistry,
  readRememberedDesktopProjects,
  type DesktopProjectRegistry,
} from './desktopProjects.js';
import { openDesktopWindow } from './desktopWindow.js';
import { installDesktopBeforeQuitWiring } from './desktopWindowLifecycle.js';
import { createDesktopWindows } from './desktopWindows.js';
import { reportFatalStartupError } from './fatalStartupError.js';
import { DESKTOP_HEADLESS } from './desktopPresentation.js';
import { initializeElectronPlatform } from './platform/index.js';
import { noticeIn } from './desktopDialogs.js';

if (DESKTOP_HEADLESS && process.platform === 'darwin')
  app.setActivationPolicy('accessory');

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

/**
 * Sets the policy on the app's own responses: its page and assets, which a
 * build reads from disk and a development run takes from the renderer's dev
 * server. Every other response keeps the headers it came with. Chromium's
 * PDF viewer in a PDF tab is one: its pages (`chrome-extension:`, loading
 * `chrome://resources`) carry their own policy, and under this one their
 * scripts are blocked and the tab stays blank. The response of a PDF on a
 * local disk does get the policy, which the viewer does not mind; one on a
 * network share (`file://server/...`) is outside the pattern and does not.
 */
function installContentSecurityPolicy(): void {
  const policy = app.isPackaged ? PRODUCTION_CSP : DEVELOPMENT_CSP;
  const devServer = process.env.ELECTRON_RENDERER_URL;
  session.defaultSession.webRequest.onHeadersReceived(
    {
      urls: [
        'file:///*',
        ...(devServer ? [`${new URL(devServer).origin}/*`] : []),
      ],
    },
    (details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [policy],
        },
      });
    },
  );
}

/**
 * The desktop entry: one program from Electron's `whenReady` to the wired
 * window. Its fatal report is the one handler, and it runs on the default
 * runner because it is what builds the process runtime. `mainDir` is the
 * entry module's directory, which `bootstrap.ts` knows and this split chunk
 * does not.
 */
export const startDesktop = (mainDir: string): void => {
  void Effect.runPromise(
    Effect.gen(function* () {
      // A rejection is a defect: nothing recovers it, and the fatal report
      // below prints the error Electron raised, not a wrapper around it.
      yield* Effect.promise(() => app.whenReady());
      // Opened by the startup program below; a startup that fails before it
      // runs the shutdown handlers that read it.
      let projects: DesktopProjectRegistry | undefined;
      // The shutdown handlers, the startup program, and every surface they
      // wire run on the process runtime the platform builds.
      const { runtime, processScope, initialize } =
        yield* initializeElectronPlatform(mainDir);
      // The process's shutdown is this scope's close. Its finalizers run in
      // the reverse of their registration: the window releases everything it
      // held (awaited), every session closes (its runs stopped and finished,
      // its artifacts flushed), the recording stops, the external-editor patch
      // directories every window's diff host recorded are removed, every
      // project is released (or, before the registry opened, the fallback
      // project's scope), and the runtime goes last. The window's release is
      // registered once the windows exist, after every other step, so it runs
      // first: the sessions never close under a window still tearing down.
      const shutdownScope = Scope.makeUnsafe();
      const shutdown = yield* Effect.cached(
        Scope.close(shutdownScope, Exit.void),
      );
      yield* Scope.addFinalizer(shutdownScope, runtime.disposeEffect);
      yield* Scope.addFinalizer(
        shutdownScope,
        Effect.suspend(
          () => projects?.dispose() ?? Scope.close(processScope, Exit.void),
        ),
      );
      // Recording has one process owner, shared by every project and window.
      // It is made here so the shutdown stops a take at this point of the
      // order, after the sessions close and before the projects go.
      const draftRequests = yield* HostDraftRequests.make.pipe(
        Scope.provide(shutdownScope),
      );
      yield* Scope.addFinalizer(
        shutdownScope,
        withProcessServices(
          runtime,
          Effect.flatMap(Sessions, (sessions) => sessions.closeAll),
        ).pipe(Effect.asVoid),
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
          const projectRecords = openDesktopProjectRecords(yield* GlobalValues);
          // Reopen every folder left open last time and show the one shown
          // last. A folder that is gone or no longer opens is reported once the
          // window exists; the others open regardless. Read before the
          // registry opens, so the recent list it starts from is pruned too.
          const remembered = yield* readRememberedDesktopProjects().pipe(
            Effect.provideService(DesktopProjectRecords, projectRecords),
          );
          // The app is a client of the one background service, so a
          // folder's tasks keep running when it quits and other windows and
          // terminals see them. An app that cannot reach it runs them here,
          // and each folder's window says so (`openProjectSession`).
          const service = yield* reachBundledService(
            platformInit.dataRoot,
            platformInit.layout.serviceRoot,
          ).pipe(Scope.provide(processScope), Effect.result);
          const registry = yield* openDesktopProjectRegistry({
            service,
            dataRoot: platformInit.dataRoot,
            processRoots: platformInit.processRoots,
            processScope,
            globalConfigStore: platformInit.globalConfigStore,
          }).pipe(Effect.provideService(DesktopProjectRecords, projectRecords));
          projects = registry;
          const unopenedProjects = [
            ...remembered.missing.map(
              (root) => `${root} (no such folder; forgotten)`,
            ),
            ...remembered.unreadable.map(
              ({ root, reason }) =>
                `${root} (could not be read; kept for the next launch): ${reason}`,
            ),
          ];
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
          yield* registry.activate(registry.list().at(-1)?.roots.workspace);

          installContentSecurityPolicy();
          const windows = createDesktopWindows({
            runtime,
            open: (hooks) =>
              openDesktopWindow(
                {
                  projects: registry,
                  draftRequests,
                  layout: platformInit.layout,
                  runtime,
                },
                hooks,
              ),
          });
          yield* Scope.addFinalizer(shutdownScope, windows.released);
          // This process holds the single-instance lock (`bootstrap.ts`): a
          // second launch focuses the running window and quits itself. One
          // that lands before the windows exist has nothing to focus.
          app.on('second-instance', () => windows.focus());
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
          // A sheet on the window, not an app-modal box: an app-modal one on
          // a fresh profile keeps the first window from appearing.
          if (notice) yield* noticeIn(processScope)('info', notice);
          app.on('activate', () => {
            if (BrowserWindow.getAllWindows().length === 0) windows.reopen();
          });
          // For the process lifetime: the fallback project's scope is the
          // last the shutdown releases.
          yield* followDesktopAttention(
            registry,
            electronAttentionPort({
              window: windows.window,
              reveal: (key, runId) =>
                windows.focus(() => windows.revealRun(key, runId)),
            }),
          ).pipe(
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
            yield* noticeIn(processScope)(
              'warning',
              `Some projects could not be reopened:\n${unopenedProjects.join('\n')}`,
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
};

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
