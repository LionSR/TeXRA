// Frame telemetry stub.
//
// Phase 1 reserves the shape but doesn't wire anything to a render loop —
// Ink doesn't expose a per-frame callback we can subscribe to outside of
// internal devtools paths, and a `setInterval`-driven timer (the first
// draft) was firing 60×/s regardless of actual paint activity. The proper
// hook lands when Phase 4 picks up Ink's frame events (or we patch
// `node_modules/.pnpm/ink*/node_modules/ink/build/render-node-to-output.js`
// behind a build switch).
//
// SIGWINCH coalescing (R13) lands alongside the multi-agent / resize work
// in Phase 4. The earlier draft of `coalesceResize` had no callers and
// shared module-level state across them — deleted rather than left as dead
// code.

import { tryPlatform } from '@platform/platform';

import { cliEnvValue } from '../../../runtime/cliContext';

interface FrameSample {
  readonly renderMs: number;
}

const TELEMETRY_ENABLED = cliEnvValue('TEXRA_TUI_FRAME_TELEMETRY') === '1';

export function logFrameSample(sample: FrameSample): void {
  if (!TELEMETRY_ENABLED) return;
  // `LogBackend` has `debug` as its lowest level — there's no `trace`. We
  // gate behind `TEXRA_TUI_FRAME_TELEMETRY=1` to keep normal runs quiet.
  tryPlatform()?.log.debug(
    'cli-tui',
    `frame render=${sample.renderMs.toFixed(2)}`,
  );
}
