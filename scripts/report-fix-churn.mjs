// A report, not a gate: the fix commits on the current branch over the last
// month, by Conventional Commit scope and by the areas the design note
// .agents/docs/proposed/architecture/2026-11-03-one-fact-one-representation.md
// counts. Its rule 4: an area that took more than ten fixes in a month has
// its rulings re-asked in the next design pass, with the fixes as evidence.
//
//   node scripts/report-fix-churn.mjs                 the last 30 days
//   node scripts/report-fix-churn.mjs --since 2026-10-01

// Node imports
import process from 'node:process';
import { parseArgs } from 'node:util';

// Local imports
import { git } from './ratchet-base.mjs';

/** The areas, each a pattern over the commit subject's word starts (`desktop` is no stop). */
const AREAS = {
  'stop/resume/ownership':
    /\b(stop|resum|interrupt|own(er|s|ed|ership)?\b|claim|liveness|cancel)/i,
  'desktop/windows': /desktop|window/i,
  'view/fold': /\b(view|fold(s|ed|ing)?\b|transcript|surface|projection)/i,
  'cli/tui': /\bcli\b|\btui\b|terminal/i,
  'model/retry/route':
    /\b(model|retry|retries|route|credential|provider|quota)/i,
};

/** More than this many fixes in a month re-asks an area's rulings. */
const REOPEN_AT = 10;

function main() {
  const { values } = parseArgs({ options: { since: { type: 'string' } } });
  const since = values.since ?? '30 days ago';
  const subjects = git('log', `--since=${since}`, '--format=%s')
    .split('\n')
    .filter((subject) => /^fix(\(|:|!)/.test(subject));
  const byScope = new Map();
  for (const subject of subjects) {
    const scope = /^fix\(([^)]*)\)/.exec(subject)?.[1] ?? '(none)';
    byScope.set(scope, (byScope.get(scope) ?? 0) + 1);
  }
  const byArea = Object.entries(AREAS).map(([area, pattern]) => [
    area,
    subjects.filter((subject) => pattern.test(subject)).length,
  ]);
  const scopes = [...byScope]
    .sort((a, b) => b[1] - a[1])
    .map(([scope, count]) => `  ${scope}: ${count}`)
    .join('\n');
  const areas = byArea
    .sort((a, b) => b[1] - a[1])
    .map(
      ([area, count]) =>
        `  ${area}: ${count}${count > REOPEN_AT ? '  (over ' + REOPEN_AT + ': re-ask its rulings)' : ''}`,
    )
    .join('\n');
  process.stdout.write(
    `fix commits since ${since}: ${subjects.length}\nby scope:\n${scopes}\nby area (a subject may count in several):\n${areas}\n`,
  );
}

main();
