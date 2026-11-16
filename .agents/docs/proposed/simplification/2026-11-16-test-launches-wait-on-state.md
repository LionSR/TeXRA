# Test launches that wait on state: what is left open

Date: 2026-11-16
Status: proposed

Origin: RT-4 and RT-8 of the 2026-11-15 design red-flag audit
(`.agents/docs/evidence/2026-11-15-design-red-flags/RT-root-tooling.md`).
The PR that adds this note lands the first step of RT-8 and the shared
pieces RT-4 builds on (one launch environment, one service stopper, one
checked fixture bundle). What is below is the rest.

## Open

1. **The TUI validator's remaining waits are wall-clock.**
   `packages/cli/scripts/validate-tui.mjs` now takes a key as
   `{ input, until }`: the driver writes the input and polls the emulated
   frame until `until` shows, failing the scenario with the key and the
   text when it does not within `KEY_UNTIL_TIMEOUT_MS`. The `/plugins` keys
   moved to it, which took the three scenarios that open the list from 46 s
   to 10 s on one machine. The other keys still sleep a fixed
   `delayMs ?? keyDelayMs ?? 500` ms, eleven of them hand-tuned, and resizes
   sleep 500 ms each.
   - Proposed: give each key an `until` (the text its answer paints; a
     typed character waits for its echo), then delete `delayMs`,
     `keyDelayMs`, `ASYNC_FORM_SETTLE_MS` and the resize delay. `settleMs`
     already ends early once the scenario's expected text shows, so it is a
     cap, not a sleep; it can become one per-scenario timeout.
   - A frame-text wait can pass on a stale frame that already showed the
     text. Where a key's answer repeats text already on screen, the harness
     (`packages/cli/scripts/tui-harness.tsx`) should print a commit counter
     after each Ink commit for the driver to wait past.
   - Then the full run is the UI's time, and it can join CI. That changes
     CI cost, so it is the repo owner's call: a nightly `schedule` run of
     `validate:tui` without `--smoke` at least, or every PR if it is fast
     enough. Only then do the `smoke` tag and the split go.
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
