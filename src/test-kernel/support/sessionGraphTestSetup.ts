/**
 * The test kernel's process runtime and session graph family over TeXRA's
 * plugins (`texraPlugins`), installed at import (`installTestSessionGraph`).
 */
import { TEXRA_SETTING_ROWS } from '@shared/settingsView/texraSettings';
import { texraPlugins } from '@tools/registry';

import { installTestSessionGraph } from './sessionGraphInstall';

await installTestSessionGraph(texraPlugins(), TEXRA_SETTING_ROWS);
