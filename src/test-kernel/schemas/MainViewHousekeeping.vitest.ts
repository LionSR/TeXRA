// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - schemas
import { MAIN_VIEW_COMMANDS } from '@common/webview/mainViewCommands';
import { MainViewInboundMessageSchema } from '@shared/schemas/mainView';

describe('MainView housekeeping messages', () => {
  it('uses inputFiles for Pack/Clean multiple payloads', () => {
    const parsed = MainViewInboundMessageSchema.parse({
      command: MAIN_VIEW_COMMANDS.PACK_MULTIPLE,
      inputFile: 'main.tex',
      inputFiles: ['chapter.tex'],
      agent: 'correct',
      model: 'gpt-5.4',
    });

    expect('inputFiles' in parsed ? parsed.inputFiles : undefined).toEqual([
      'chapter.tex',
    ]);
  });
});
