import { describe, expect, it } from 'vitest';

import type { ActiveChildInfo } from '@shared/schemas';
import {
  EMPTY_STREAM_META,
  reduceStreamMeta,
  type StreamMeta,
} from '@shared/streams/streamMetaReducer';

const OPTS = { outputCap: { maxChars: 100 } } as const;

function meta(overrides: Partial<StreamMeta> = {}): StreamMeta {
  return { ...EMPTY_STREAM_META, ...overrides };
}

describe('reduceStreamMeta', () => {
  describe('processOutput cap policies', () => {
    it('exact head-cut at the cap when retainChars is omitted (CLI policy)', () => {
      const base = meta({
        processOutput: new Map([['e', { stdout: '0123456789', stderr: '' }]]),
      });
      // combined = "0123456789abc" (13) > 5 → keep last 5 → "89abc".
      const next = reduceStreamMeta(
        base,
        { kind: 'processOutput', executionId: 'e', stdout: 'abc', stderr: '' },
        { outputCap: { maxChars: 5 } },
      );
      expect(next.processOutput.get('e')).toEqual({
        stdout: '89abc',
        stderr: '',
      });
    });

    it('trims to retainChars once maxChars is crossed (webview 100k→80k policy)', () => {
      const base = meta({
        processOutput: new Map([['e', { stdout: '0123456789', stderr: '' }]]),
      });
      // combined length 13 > 10 → keep last 5 → "89abc".
      const next = reduceStreamMeta(
        base,
        { kind: 'processOutput', executionId: 'e', stdout: 'abc', stderr: '' },
        { outputCap: { maxChars: 10, retainChars: 5 } },
      );
      expect(next.processOutput.get('e')?.stdout).toBe('89abc');
    });

    it('clamps retainChars to maxChars', () => {
      const base = meta({
        processOutput: new Map([['e', { stdout: '0123456789', stderr: '' }]]),
      });
      const next = reduceStreamMeta(
        base,
        { kind: 'processOutput', executionId: 'e', stdout: 'abc', stderr: '' },
        { outputCap: { maxChars: 5, retainChars: 100 } },
      );
      expect(next.processOutput.get('e')?.stdout).toBe('89abc');
    });

    it('keeps appending up to maxChars before the next reset', () => {
      const base = meta({
        processOutput: new Map([['e', { stdout: '012345', stderr: '' }]]),
      });
      // combined "012345ab" (8) <= 10 → plain append, no reset yet.
      const next = reduceStreamMeta(
        base,
        { kind: 'processOutput', executionId: 'e', stdout: 'ab', stderr: '' },
        { outputCap: { maxChars: 10, retainChars: 5 } },
      );
      expect(next.processOutput.get('e')?.stdout).toBe('012345ab');
    });

    it('seeds a missing execution entry from empty', () => {
      const next = reduceStreamMeta(
        meta(),
        {
          kind: 'processOutput',
          executionId: 'new',
          stdout: 'hi',
          stderr: 'e',
        },
        OPTS,
      );
      expect(next.processOutput.get('new')).toEqual({
        stdout: 'hi',
        stderr: 'e',
      });
    });
  });

  describe('activeProcesses', () => {
    const active: ActiveChildInfo = {
      kind: 'process',
      executionId: 'active',
      agentName: 'bash',
    };

    it('sets the active list and prunes output for vanished processes', () => {
      const base = meta({
        activeProcesses: [],
        processOutput: new Map([
          ['active', { stdout: 'a', stderr: '' }],
          ['stale', { stdout: 's', stderr: '' }],
        ]),
      });
      const next = reduceStreamMeta(
        base,
        { kind: 'activeProcesses', processes: [active] },
        OPTS,
      );
      expect(next.activeProcesses).toEqual([active]);
      expect(next.processOutput.has('active')).toBe(true);
      expect(next.processOutput.has('stale')).toBe(false);
      // Input is untouched.
      expect(base.processOutput.has('stale')).toBe(true);
    });

    it('keeps the same output-map identity when nothing is pruned', () => {
      const output = new Map([['active', { stdout: 'a', stderr: '' }]]);
      const base = meta({ processOutput: output });
      const next = reduceStreamMeta(
        base,
        { kind: 'activeProcesses', processes: [active] },
        OPTS,
      );
      expect(next.processOutput).toBe(output);
    });
  });

  describe('purity', () => {
    it('returns a fresh meta and map without mutating the input', () => {
      const output = new Map([['e', { stdout: 'x', stderr: '' }]]);
      const base = meta({ processOutput: output });
      const next = reduceStreamMeta(
        base,
        { kind: 'processOutput', executionId: 'e', stdout: 'y', stderr: '' },
        OPTS,
      );
      expect(next).not.toBe(base);
      expect(next.processOutput).not.toBe(output);
      expect(output.get('e')).toEqual({ stdout: 'x', stderr: '' });
    });
  });
});
