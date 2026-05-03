import type { ClipboardHost } from './clipboardHost';
import type { DiffViewHost } from './diffViewHost';
import type { ExternalOpener } from './externalOpener';
import type { PromptHost } from './promptHost';
import type { TerminalHost } from './terminalHost';

export interface UIHosts {
  readonly prompt: PromptHost;
  readonly externalOpener: ExternalOpener;
  readonly diff: DiffViewHost;
  readonly terminal: TerminalHost;
  readonly clipboard: ClipboardHost;
}
