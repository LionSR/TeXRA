// Local imports
import { VscodeDiffViewHost } from '@frontend/approval/VscodeDiffViewHost';
import type { UIHosts } from '@hosts/uiHosts';

import { VscodeClipboardHost } from './VscodeClipboardHost';
import { VscodeExternalOpener } from './VscodeExternalOpener';
import { VscodePromptHost } from './VscodePromptHost';
import { VscodeTerminalHost } from './VscodeTerminalHost';

export function createVscodeUIHosts(): UIHosts {
  return {
    prompt: new VscodePromptHost(),
    externalOpener: new VscodeExternalOpener(),
    diff: new VscodeDiffViewHost(),
    terminal: new VscodeTerminalHost(),
    clipboard: new VscodeClipboardHost(),
  };
}
