// Web Awesome tab components used by root view navigation.
import '@awesome.me/webawesome/dist/components/tab-group/tab-group.js';
import '@awesome.me/webawesome/dist/components/tab/tab.js';
import '@awesome.me/webawesome/dist/components/tab-panel/tab-panel.js';

export type WaTabShowEvent = CustomEvent<{ name: string }>;

export type MutableWaTabGroup = {
  active?: string;
};
