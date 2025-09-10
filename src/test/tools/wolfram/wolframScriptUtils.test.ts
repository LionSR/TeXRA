// Standard library imports
import { strict as assert } from 'assert';

// Local imports
import {
  executeWolframCode,
  executeWolframScriptFile,
} from '@tools/wolfram/wolframScriptUtils';

describe('wolframScriptUtils', () => {
  it('fails gracefully when wolframscript is missing for code execution', async () => {
    const result = await executeWolframCode('1+1');
    assert.equal(result.success, false);
    assert.equal(result.output, null);
    assert.ok(result.error);
  });

  it('fails gracefully when wolframscript is missing for script files', async () => {
    const result = await executeWolframScriptFile('dummy.wl');
    assert.equal(result.success, false);
    assert.equal(result.output, null);
    assert.ok(result.error);
  });
});

