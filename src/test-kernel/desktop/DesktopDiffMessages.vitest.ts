import { beforeAll, describe, expect, it } from 'vitest';

import { loadSourceModule } from './loadSourceModule.ts';

type DesktopDiffMessagesModule = typeof import('@desktop/shared/desktopDiffMessages');

let DesktopShowDiffMessageSchema!: DesktopDiffMessagesModule['DesktopShowDiffMessageSchema'];

describe('DesktopShowDiffMessageSchema', () => {
  const basePayload = {
    command: 'desktop:showDiff',
    title: 'Compare',
    originalText: 'a',
    proposedText: 'b',
  } as const;

  beforeAll(async () => {
    ({ DesktopShowDiffMessageSchema } = await loadSourceModule(
      '@desktop/shared/desktopDiffMessages',
    ));
  });

  it('round-trips a complete payload', () => {
    const parsed = DesktopShowDiffMessageSchema.parse({
      ...basePayload,
      displayPath: 'src/file.ts',
      additions: 1,
      deletions: 1,
      language: 'latex',
    });
    expect(parsed.command).toBe('desktop:showDiff');
    expect(parsed.language).toBe('latex');
    expect(parsed.displayPath).toBe('src/file.ts');
  });

  it('requires displayPath', () => {
    const result = DesktopShowDiffMessageSchema.safeParse(basePayload);
    expect(result.success).toBe(false);
  });

  it('defaults missing language to plaintext', () => {
    const parsed = DesktopShowDiffMessageSchema.parse({
      ...basePayload,
      displayPath: 'src/file.ts',
    });
    expect(parsed.language).toBe('plaintext');
    expect(parsed.additions).toBe(0);
    expect(parsed.deletions).toBe(0);
  });
});
