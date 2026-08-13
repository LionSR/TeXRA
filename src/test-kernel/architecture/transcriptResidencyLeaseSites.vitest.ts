// Node imports
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Third-party imports
import { describe, expect, it } from 'vitest';

import {
  productionFilesUnder,
  REPO_ROOT,
  stripComments,
} from '../support/repoScan';

const SCAN_ROOTS = [
  'packages/cli/src',
  'packages/desktop/src',
  'packages/extension/src',
  'src',
] as const;

/** Runtime sites allowed to perform ordinary transcript hydration. */
const HYDRATION_SITE_ALLOWLIST = new Set([
  'packages/cli/src/chat/chatSessionController.ts',
  'packages/cli/src/chat/tui/state/subscribeStreamLog.ts',
  'src/agent/implementations/flows/tooluse/nodes/ToolUseWaitNode.ts',
  'src/agent/runtime/executeAgent.ts',
  'src/controllers/progressView/backend/ProgressBackend.ts',
  'src/controllers/session/SessionFactApplier.ts',
  'src/transcript/StreamLogStore.ts',
]);

/** The progress coordinator is the sole production presentation lease owner. */
const PRESENTATION_LEASE_SITE_ALLOWLIST = new Set([
  'src/controllers/progressView/backend/ProgressBackend.ts',
  'src/transcript/StreamLogStore.ts',
]);

describe('transcript residency lease sites', () => {
  it('keeps transcript hydration at the closed focus/runtime boundary', () => {
    const offenders = SCAN_ROOTS.flatMap(productionFilesUnder)
      .filter((file) => !HYDRATION_SITE_ALLOWLIST.has(file))
      .filter((file) =>
        /\.ensureLoaded\s*\(/.test(
          stripComments(readFileSync(resolve(REPO_ROOT, file), 'utf8')),
        ),
      )
      .toSorted();

    expect(
      offenders,
      offenders.length === 0
        ? undefined
        : 'Use zero-residency readEntries() for one-shot reads; extend the allowlist only for a new focus/runtime owner.',
    ).toEqual([]);
  });

  it('keeps exact presentation residency at the progress coordinator boundary', () => {
    const offenders = SCAN_ROOTS.flatMap(productionFilesUnder)
      .filter((file) => !PRESENTATION_LEASE_SITE_ALLOWLIST.has(file))
      .filter((file) =>
        /retainForPresentation\s*:\s*true/.test(
          stripComments(readFileSync(resolve(REPO_ROOT, file), 'utf8')),
        ),
      )
      .toSorted();

    expect(offenders).toEqual([]);
  });
});
