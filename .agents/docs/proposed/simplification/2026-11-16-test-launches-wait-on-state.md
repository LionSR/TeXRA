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
waits below, lost `model-form-buffered-hotkey` in 2 of 7 runs.

## Open

1. **Whether the full `validate:tui` joins CI.** It is the UI's own time now.
   That changes CI cost, so it is the repo owner's call: a nightly `schedule`
   run of `validate:tui` without `--smoke` at least, or every PR. Only then
   do the `smoke` tag and the split go.
2. **A key typed while an async `/` list loads is dropped (product).** Six
   scenarios answer a list right after opening it (`config-form`,
   `config-category-back-responsive`, `model-form-selectable-submit`,
   `model-form-buffered-hotkey`, `skills-form-select-submit`,
   `skills-form-buffered-hotkey`). On `main` they passed because the fixed
   500 ms delay after the opening Enter let the list load first, so the two
   `buffered-hotkey` scenarios never exercised the buffering they are named
   for. Sent as soon as the opening key is answered, the next key lands
   while the list is still loading: an Enter or arrow is dropped by design
   (`shouldBufferAsyncListFormInput` buffers only printable keys), and a
   buffered hotkey was lost in 4 of the 6 tries that landed in the loading
   frame (`/skills`, all CPUs saturated). The probable cause, not
   confirmed: between the commit that ends `loading` and the passive effect
   that subscribes `Select`'s `useInput`, a key reaches neither the form's
   buffer (no longer loading) nor the list. The scenarios now wait for the
   loaded rows, which is what the delay covered.
   - Two more, `api-form-chatgpt-hotkey` and `api-form-kimi-hotkey`, press
     a `/login` row's hotkey right after opening it. That list mounts at
     once, but its rows read "Loading current preference" until the account
     state loads, and the loaded rows are not the same set; they now wait
     for a loaded row too. They did not fail in the measured runs.
   - Proposed: the form holds every key that arrives before its list is
     listening (Enter and arrows included) and replays it once `Select`
     subscribes, owned in `useAsyncListForm`
     (`packages/cli/src/chat/tui/forms/_shared/useAsyncListForm.ts`); then
     `model-form-buffered-hotkey` and `skills-form-buffered-hotkey` press
     their hotkey without waiting, and so test the buffering.
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
