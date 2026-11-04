// Third-party imports
import { Effect } from 'effect';

// Local imports
import {
  Settings,
  withLogChannel,
  type SettingsStores,
} from '@texra-ai/harness/host';
import { RESUME_ON_OPEN_KEY } from '@texra/shared/settingsView/texraSettings';

/**
 * What a TeXRA window's session does at open with its interrupted tasks
 * (`OpenOptions.host.interruptedTasks`), as the user's `resumeOnOpen` says:
 * `ask` lists them, `auto` resumes them. A setting that cannot be read
 * lists them, the default, and says why.
 */
export const interruptedTasksOnOpen = (
  stores: SettingsStores,
): Effect.Effect<'list' | 'resume'> =>
  Settings.get<'ask' | 'auto'>(stores, RESUME_ON_OPEN_KEY).pipe(
    Effect.map((policy) => (policy === 'auto' ? 'resume' : 'list')),
    Effect.catch((error) =>
      Effect.logWarning('Could not read resumeOnOpen; listing tasks').pipe(
        Effect.annotateLogs({ data: error }),
        withLogChannel('InterruptedTasks'),
        Effect.as('list' as const),
      ),
    ),
  );
