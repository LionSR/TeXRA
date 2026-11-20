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
  frame is written. A report carries the input bytes Ink has read, the
  count of key events whose frame is written (the counter a key's wait
  passes, which the commit counter proposed here became), the terminal size the
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
  waits `until` (an async `/` list's loaded rows: `PLUGINS_FORM_KEYS`,
  `CONFIG_FORM_KEYS`, `SKILLS_FORM_KEYS`, `MODEL_PICKER_KEYS`,
  `LOGIN_FORM_KEYS`) or
  `untilGone` (the two scenarios that return from a focused child with Esc,
  which macOS defers by its chord window).
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
(`--no-build`):

| Run               | `main` (fixed waits) | State waits    |
| ----------------- | -------------------- | -------------- |
| 1                 | 585 s, 143/143       | 248 s, 142/143 |
| 2                 | 580 s, 143/143       | 243 s, 142/143 |
| 3                 | 586 s, 143/143       | 240 s, 142/143 |
| 4                 |                      | 249 s, 142/143 |
| 5                 |                      | 249 s, 142/143 |
| every CPU busy, 1 |                      | 318 s, 142/143 |
| every CPU busy, 2 |                      | 328 s, 142/143 |

The one failure in each state-wait run is `multi-agent-toggle`, which failed
the same way on `main` once a plugin's removal moved its row's hotkey; it is
fixed in the same PR, and the merged tree then ran 143/143 in 245 s. No
scenario failed in only some runs. An earlier round, before the async-list
waits, lost `model-form-buffered-hotkey` in 2 of 7 runs.

**An async `/` list acts on the keys typed while it loads.** Those runs
exposed it: a key read after the commit that ends `loading` and before the
list's `Select` subscribes (that commit's passive effects run in a later
task) reached neither the form's loading buffer nor the list, and the
buffer took only one printable key. `useAsyncListForm`
(`packages/cli/src/chat/tui/forms/_shared/useAsyncListForm.ts`) now holds
every key but Esc and Ctrl chords until its own passive effect on the
commit that shows the list, which React runs after the list's, and
replays them in order through Ink's input events. `model-form-buffered-hotkey`
and `skills-form-buffered-hotkey` press their hotkey as soon as the opening
Enter is read (`untilRead`). With every CPU busy they failed 5 of 20 runs
before the fix and passed 20 of 20 after.

## Open

1. **Whether the full `validate:tui` joins CI.** It is the UI's own time now.
   That changes CI cost, so it is the repo owner's call: a nightly `schedule`
   run of `validate:tui` without `--smoke` at least, or every PR. Only then
   do the `smoke` tag and the split go. 2026-11-20: the nightly run landed
   (the `tui-validation` job of `.github/workflows/ci.yml`); every PR is
   still open, and with it the `smoke` tag.
2. **`/login`'s rows while its account state loads.** Its list mounts and
   listens at once, but the subscription rows are disabled until the
   account state loads, so a hotkey typed in that window selects nothing.
   No key is lost between listeners (the case the async `/` lists had);
   the rows are not actionable yet. `api-form-chatgpt-hotkey` and
   `api-form-kimi-hotkey` wait for a loaded row (`LOGIN_FORM_KEYS`).
   Proposed only if it shows up in use: hold keys until the account state
   loads, as `useAsyncListForm` does, with the list not listening
   meanwhile.
3. **The packaged desktop smoke is a second launch harness.**
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
