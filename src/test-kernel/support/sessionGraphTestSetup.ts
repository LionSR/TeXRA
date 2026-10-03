/**
 * The test kernel's process runtime and session graph family over TeXRA's
 * plugins (`texraPlugins`), installed at import (`installTestSessionGraph`).
 */
import { texraPlugins } from '@tools/registry';

import { installTestSessionGraph } from './sessionGraphInstall';

await installTestSessionGraph(texraPlugins());
