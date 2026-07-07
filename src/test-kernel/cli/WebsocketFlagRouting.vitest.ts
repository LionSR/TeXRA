import { describe, expect, it } from 'vitest';

import {
  GLOBAL_BOOL_FLAGS,
  GLOBAL_ARGS,
} from '@cli/commands/_helpers/globalArgs';
import { knownGlobalFlagTokenCount } from '@cli/commands/_helpers/dispatch';

/**
 * `--websocket` is an opt-in boolean with no default (unset → defer to the
 * stored toggle), so its negated `--no-websocket` spelling must still be
 * registered for leading-flag routing — otherwise `texra --no-websocket run …`
 * stops on an "unknown flag". Booleans that advertise a `negativeDescription`
 * (the documented negative form) get their `--no-<name>` registered, not only
 * those defaulting to `true` like `--no-color`.
 */
describe('websocket global flag routing', () => {
  it('registers both --websocket and --no-websocket as leading global flags', () => {
    expect(GLOBAL_BOOL_FLAGS.has('--websocket')).toBe(true);
    expect(GLOBAL_BOOL_FLAGS.has('--no-websocket')).toBe(true);
  });

  it('still registers --no-color (default:true) alongside the new condition', () => {
    expect(GLOBAL_BOOL_FLAGS.has('--no-color')).toBe(true);
  });

  it('does not register a negated form for plain booleans (e.g. --print)', () => {
    // `print` has neither default:true nor a negativeDescription.
    expect('negativeDescription' in GLOBAL_ARGS.print).toBe(false);
    expect(GLOBAL_BOOL_FLAGS.has('--no-print')).toBe(false);
  });

  it('recognizes a leading --no-websocket as a single-token global flag', () => {
    expect(
      knownGlobalFlagTokenCount(['--no-websocket', 'run', 'polish'], 0),
    ).toBe(1);
    expect(knownGlobalFlagTokenCount(['--websocket', 'run'], 0)).toBe(1);
  });
});
