/**
 * The test kernel's process runtime and session graph family over TeXRA's
 * plugins (`texraPlugins`, over the installed fake host's setup platform),
 * installed at import (`installTestSessionGraph`).
 */
import { texraPlugins } from '@texra/tools/registry';

import { installTestSessionGraph } from './sessionGraphInstall';
import { fakeSetupPlatform } from './setupPlatform';

await installTestSessionGraph(texraPlugins({ setup: fakeSetupPlatform }));
