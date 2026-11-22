/**
 * A plugin of TeXRA's list from its definition: what `definePlugin` makes of
 * a harness plugin, for one that also carries its card and icons.
 */
// Local imports - harness
import { definePlugin } from '@texra-ai/worldline/plugins';

// Local imports - tools
import type { TexraPlugin } from '@texra/tools/registry';

/** `plugin` itself, frozen as `definePlugin` freezes a definition: its card,
 *  icons and the rest are one value every session of the process reads. */
export const texraPlugin = (plugin: TexraPlugin): TexraPlugin => {
  definePlugin(plugin);
  return plugin;
};
