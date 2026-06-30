// Third-party imports
import { strict as assert } from 'node:assert';
import { describe, it, afterEach, vi } from 'vitest';

// Local imports - tools
import {
  executeWolframCode,
  executeWolframScriptFile,
} from '@tools/wolfram/wolframScriptUtils';
import * as toolUtils from '@utils/system/toolUtils';
import * as execUtils from '@utils/system/execUtils';

describe('wolframScriptUtils', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    {
      name: 'executeWolframCode delegates to runWolfram with code args',
      run: () => executeWolframCode('1+1'),
      stdout: '2',
      expectedArgs: ['wolframscript', '-code', '1+1'],
      expectedTimeout: 30000,
    },
    {
      name: 'executeWolframScriptFile delegates to runWolfram with file args',
      run: () => executeWolframScriptFile('/tmp/test.wls'),
      stdout: 'done',
      expectedArgs: ['wolframscript', '-file', '/tmp/test.wls'],
      expectedTimeout: 60000,
    },
  ])('$name', async ({ run, stdout, expectedArgs, expectedTimeout }) => {
    const calls: any[] = [];
    vi.spyOn(toolUtils, 'checkToolInstalled').mockResolvedValue(true);
    vi.spyOn(execUtils, 'executeCommand').mockImplementation(
      async (command, opts) => {
        calls.push(command, opts);
        return { success: true, stdout, stderr: '' } as any;
      },
    );

    const result = await run();

    assert.deepStrictEqual(calls[0], expectedArgs);
    assert.strictEqual(calls[1].timeout, expectedTimeout);
    assert.ok(result.success);
    assert.strictEqual(result.output, stdout);
  });
});
