import { describe, expect, it } from 'vitest';

import {
  CliNdjsonRecordSchema,
  type CliNdjsonRecord,
} from '@cli/schemas/cliOutput';

/**
 * Locks the `--output-format ndjson` wire contract. One representative record
 * per `kind` a command emits — mirroring the shapes built in
 * `packages/cli/src/commands/*` and the `cli*NdjsonRecords` helpers — must parse
 * against the shared schema. If a command starts emitting a new `kind` (or
 * renames one) without registering it here and in `cliOutput.ts`, this fails.
 */
const REPRESENTATIVE_RECORDS: CliNdjsonRecord[] = [
  { kind: 'agent', agent: { name: 'coder' } },
  { kind: 'agent-roster', roster: { selection: { kind: 'all' } } },
  { kind: 'config', config: { settings: {}, agents: {} } },
  { kind: 'tool-status', tool: { name: 'bash', available: true } },
  { kind: 'tool-toggle', tool: { id: 'codex', enabled: false } },
  { kind: 'tool-guide', guide: { id: 'codex', operation: 'install' } },
  { kind: 'version', version: '0.39.1' },
  { kind: 'model', model: { id: 'sonnet45', label: 'Sonnet 4.5' } },
  {
    kind: 'model-catalog',
    model: { id: 'grok45', enabled: true, provider: 'xai' },
  },
  { kind: 'models-enabled', models: ['deepseekproT', 'grok45'] },
  {
    kind: 'model-enabled',
    model: { id: 'grok45', enabled: true, list: ['grok45'] },
  },
  { kind: 'memory', memory: { id: 'm1', text: 'remember' } },
  { kind: 'memory-detail', id: 'm1', text: 'remember', scope: 'workspace' },
  { kind: 'auth', authenticated: true, account: 'a@b.c', expiresAt: 1 },
  { kind: 'auth', authenticated: false, relayTokenConfigured: true },
  { kind: 'auth-status', authenticated: true, tier: 'pro' },
  { kind: 'init-config', init: { path: '.texra/config.json' } },
  { kind: 'relay-usage', tier: 'pro', costUsd: 1, limitUsd: 10 },
  { kind: 'relay-token', name: 'ci', token: 'secret' },
  { kind: 'relay-token-info', name: 'ci', createdAt: 1 },
  { kind: 'relay-token-revoked', name: 'ci' },
  { kind: 'history-entry', entry: { id: 'e1' } },
  { kind: 'history-detail', detail: { id: 'e1' } },
  { kind: 'history-delete', result: { deleted: 3 } },
  { kind: 'multi-agent-result', agent: 'team', outputFiles: [] },
  { kind: 'multi-agent-preset', preset: { id: 'p1' } },
  { kind: 'multi-agent-preset-inspection', plan: { id: 'p1' } },
  { kind: 'agent-result', result: { outputFiles: [] } },
  { kind: 'result', result: { category: 'workflow' } },
  { kind: 'skill', ts: '2026-01-01T00:00:00.000Z', skill: { name: 's1' } },
  { kind: 'skill-issue', ts: '2026-01-01T00:00:00.000Z', issue: { code: 'x' } },
  { kind: 'doctor-check', ts: '2026-01-01T00:00:00.000Z', id: 'node' },
  { kind: 'doctor-summary', ts: '2026-01-01T00:00:00.000Z', ok: true },
  { kind: 'progress', ts: '2026-01-01T00:00:00.000Z', event: 'setTaskState' },
  { kind: 'log', ts: '2026-01-01T00:00:00.000Z', level: 'info' },
];

describe('CLI NDJSON record contract', () => {
  it.each(REPRESENTATIVE_RECORDS)('accepts %o', (record) => {
    expect(CliNdjsonRecordSchema.safeParse(record).success).toBe(true);
  });

  it('tolerates the downstream `ts` stamp on every record', () => {
    for (const record of REPRESENTATIVE_RECORDS) {
      const stamped = { ...record, ts: '2026-06-14T00:00:00.000Z' };
      expect(CliNdjsonRecordSchema.safeParse(stamped).success).toBe(true);
    }
  });

  it('rejects an unregistered kind', () => {
    expect(
      CliNdjsonRecordSchema.safeParse({ kind: 'not-a-real-kind' }).success,
    ).toBe(false);
  });
});
