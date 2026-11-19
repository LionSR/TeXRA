# Test launches that wait on state: what is left open

Date: 2026-11-16
Status: proposed

Origin: RT-4 and RT-8 of the 2026-11-15 design red-flag audit
(`.agents/docs/evidence/2026-11-15-design-red-flags/RT-root-tooling.md`).
The PR that adds this note lands the first step of RT-8 and the shared
pieces RT-4 builds on (one launch environment, one service stopper, one
checked fixture bundle). What is below is the rest.

## Landed

**The TUI validator waits on state.** `packages/cli/scripts/validate-tui.mjs`
has no fixed wait left but one (below); `delayMs`, `keyDelayMs`, `settleMs`,
`ASYNC_FORM_SETTLE_MS`, the resize delay and the quiet-terminal windows at
boot and before the final frame are gone.

- The harness (`packages/cli/scripts/tui-harness.tsx`) reports its state in a
  private OSC sequence written in order with the frame bytes, after each
  burst of output, after a resize, and after each dispatched key once its
  frame is written. A report carries a commit counter, the input bytes Ink
  has read, the key events whose frame is written, the terminal size the
  frame was drawn for, whether stdin is raw, and whether the TUI has caught
  up with the session (the session has drained its writes, the bound view
  signal holds the session's current view, and every run in it has its
  transcript).
- The driver has one wait, `waitFor`: a condition over the latest report and
  the emulated screen as of that report, asked again at each report. A
  screen is only read when a report is the last thing received, so a frame
  is never read half written. Boot waits for raw mode, a caught-up TUI and
  the boot text; a key for its bytes read, its events rendered and a
  caught-up TUI; a resize for a frame at the new size (after the
  scrollback clear, on a width change); the final frame for the expected
  text on a caught-up TUI. `STATE_TIMEOUT_MS` bounds each.
- A key's own report is written when the event loop next goes idle after
  its dispatch (Node's `eventLoopUtilization().idle`), since some handlers
  hand their work to a fiber or a signal a turn later. Work that waits on
  I/O or a timer of its own is outside that: such a key names the text it
  waits `until` (the `/plugins` list) or `untilGone` (the two scenarios
  that return from a focused child with Esc, which macOS defers by its
  chord window).
- What stays on the clock, and why:
  - `ESC_CHORD_WINDOW_MS` (700 ms, macOS only, `escape-leaves-root-running`):
    the App holds a bare Esc for its 500 ms chord window and then drops it
    with nothing to paint, and the scenario asserts what that leaves alone.
    The window is the App's real-time `Effect.sleep`; only a product change
    (a published "chord pending" fact, or the test clock) would make it
    observable.
  - The 80 ms between chunks of the harness's streamed tool output: the
    fixture's own pacing of a stream that arrives over time, not a wait for
    the UI.
  - The 1 ms timer in the harness's idle probe gives the event loop
    something to block on; the wait is on the idle counter.
- Two fixture waits in the harness went with it: the 25 ms poll for a child
  focus is a signal subscription, and the stream fixture starts on the first
  painted frame rather than after one second.

Measured on a 4-core Linux container, 143 scenarios, harness already built
(`--no-build`); `main` at the time took 580 to 585 s:

MEASURED_TABLE

## Open

1. **Whether the full `validate:tui` joins CI.** It is the UI's own time now.
   That changes CI cost, so it is the repo owner's call: a nightly `schedule`
   run of `validate:tui` without `--smoke` at least, or every PR. Only then
   do the `smoke` tag and the split go.
2. **The packaged desktop smoke is a second launch harness.**
   `scripts/verify-desktop.mjs`'s `smoke-package` stage (with
   `scripts/smoke-process-utils.mjs`) launches the packaged app, decides
   it is ready by polling renderer markup (`main#app`, the progress view's
   shadow root, `.shell-project-workbench[data-session]`, the theme kind),
   and closes it with its own signal ladder. The e2e fixture
   (`packages/desktop/tests/e2e/electronApp.ts`) launches the dev build and
   waits on the flag the renderer publishes (`document.body.dataset.desktopReady`). They
   now share the launch environment (`testLaunchEnv`), the service stopper
   (`scripts/texra-services.mjs`) and the project seeding.
   - Proposed: one launcher. `launchTexraApp` takes the packaged executable
     from an environment variable the installer workflow sets from its
     matrix row, keeps the packaged run's environment allowlist as a policy
     argument, and both runs wait on published flags. The renderer
     publishes a second flag where the project workbench mounts (the
     desktop package's change), since `desktopReady` is set before
     the project list arrives. The packaged smoke becomes one spec in a
     `packaged` Playwright project; the `smoke-package` stage,
     `smoke-process-utils.mjs`, `defaultPackagedExecutables` and the
     markup poll go.
   - Needs: the renderer flag from the desktop owner, and a change to
     `.github/workflows/desktop-package.yml` (run `playwright test` under
     `xvfb-run` on Linux) that can only be checked in a dispatched installer
     run, since nothing else packages the app.
