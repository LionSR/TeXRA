declare module 'turndown-plugin-gfm' {
  import TurndownService from 'turndown';

  export type TurndownPlugin = (service: TurndownService) => void;

  export const gfm: TurndownPlugin;
  export const highlightedCodeBlock: TurndownPlugin;
  export const strikethrough: TurndownPlugin;
  export const tables: TurndownPlugin;
  export const taskListItems: TurndownPlugin;
}
