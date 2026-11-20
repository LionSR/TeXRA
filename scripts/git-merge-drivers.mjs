#!/usr/bin/env node
// Registers the `api-report` merge driver that `.gitattributes` names for the
// generated API reports (`config/api-reports/`, `packages/{harness,llm}/docs/api/`,
// the paths `GENERATED_DIRS` and `PACKAGES` in `check-api-report.mjs` write). Two
// branches that both change the public surface conflict in those files on
// every merge, and the right result is never either side: it is what
// `npm run docgen` writes from the merged sources. The driver keeps this
// branch's copy so the merge stops only on real source conflicts; run
// `npm run docgen` after the merge. `check-api-report.mjs` (in the gate)
// fails a report that does not match the sources, so a skipped docgen cannot
// land. A merge driver lives in git config, not in the tree, so `pnpm
// install` runs this as the root `prepare` script. GitHub's own conflict
// check and its "Update branch" button do not run custom drivers.

import console from 'node:console';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const rootDir = path.resolve(import.meta.dirname, '..');
// An unpacked tarball or a CI cache restore has no repository to configure.
if (!existsSync(path.join(rootDir, '.git'))) process.exit(0);

const git = (...args) =>
  execFileSync('git', args, { cwd: rootDir, stdio: 'inherit' });
git(
  'config',
  'merge.api-report.name',
  'keep ours; regenerate with npm run docgen',
);
git('config', 'merge.api-report.driver', 'true');
console.log('git merge driver api-report registered (see .gitattributes)');
