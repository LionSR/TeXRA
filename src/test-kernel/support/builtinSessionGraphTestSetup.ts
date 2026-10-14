/**
 * The test kernel's process runtime and session graph family over the
 * harness's built-ins alone (`harnessBuiltins`): no TeXRA plugin.
 */
import { harnessBuiltins } from '@tools/builtinPlugins';

import { installTestSessionGraph } from './sessionGraphInstall';

await installTestSessionGraph(harnessBuiltins);
