// Node imports
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Third-party imports
import { describe, expect, it } from 'vitest';

import {
  productionFilesUnder,
  REPO_ROOT,
  stripComments,
} from '../support/repoScan';

const RETIRED_MODULE =
  'src/controllers/progressView/backend/events/ProgressEventHandler.ts';
const RETIRED_EXTENSION_PROGRESS_MODULE =
  'packages/extension/src/frontend/events/extensionProgressEvents.ts';
const RETIRED_SYMBOL = /\bProgressEventHandler\b/;
const RETIRED_DESKTOP_PROGRESS_BRIDGE_TERMS = [
  'DesktopProgressEventBridge',
  'desktopProgressEventBridge',
  'progress-event bridge',
] as const;

const SCAN_ROOTS = [
  'packages/cli/src',
  'packages/desktop/src',
  'packages/extension/src',
  'src',
] as const;

function mentionsRetiredSymbol(file: string): boolean {
  const source = stripComments(readFileSync(resolve(REPO_ROOT, file), 'utf8'));
  return RETIRED_SYMBOL.test(source);
}

function mentionsRetiredDesktopProgressBridgeTerm(file: string): boolean {
  const source = readFileSync(resolve(REPO_ROOT, file), 'utf8');
  return RETIRED_DESKTOP_PROGRESS_BRIDGE_TERMS.some((term) =>
    source.includes(term),
  );
}

describe('ProgressEventHandler retirement boundary', () => {
  it.each([RETIRED_MODULE, RETIRED_EXTENSION_PROGRESS_MODULE])(
    'removes the retired module %s',
    (module) => {
      expect(existsSync(resolve(REPO_ROOT, module))).toBe(false);
    },
  );

  it('removes the ProgressEventHandler class name from production sources', () => {
    const offenders = SCAN_ROOTS.flatMap(productionFilesUnder)
      .filter(mentionsRetiredSymbol)
      .toSorted();

    expect(offenders).toEqual([]);
  });

  it('removes retired desktop progress bridge vocabulary from production desktop sources', () => {
    const offenders = productionFilesUnder('packages/desktop/src')
      .filter(mentionsRetiredDesktopProgressBridgeTerm)
      .toSorted();

    expect(offenders).toEqual([]);
  });

  it('actually scans the production source roots', () => {
    const scanned = SCAN_ROOTS.reduce(
      (total, root) => total + productionFilesUnder(root).length,
      0,
    );
    expect(scanned).toBeGreaterThan(100);
  });
});
