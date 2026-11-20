import { Effect } from 'effect';

import { runCli } from '../commands/root';
import { formatCrashReportLine } from '../runtime/platform/cliContext';
import { runCliEntry } from '../runtime/platform/logSinks';

// The process entry: one run. Each command disposes the runtime it built
// (`cliCommand`), so nothing is left here to shut down. A crash that
// reaches here was not expected, so it points the user at the tracker;
// `formatCrashReportLine` keeps that line off a usage error even if one is
// ever rethrown.
await Effect.runPromise(
  runCliEntry(
    'TeXRA CLI',
    async () => (await runCli()).exitCode,
    formatCrashReportLine,
  ),
);
