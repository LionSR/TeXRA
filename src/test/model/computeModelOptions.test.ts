import * as assert from 'assert';
import * as sinon from 'sinon';
import { computeModelOptions } from '../../model/computeModelOptions';
import { SecretManager } from '../../frontend/secretManager';
import * as config from '../../utils/config';

suite('computeModelOptions', () => {
  let getConfigStub: sinon.SinonStub;
  let apiKeyExistsStub: sinon.SinonStub;

  setup(() => {
    getConfigStub = sinon.stub(config, 'getConfig');
    apiKeyExistsStub = sinon.stub(SecretManager, 'apiKeyExists');
  });

  teardown(() => {
    sinon.restore();
  });

  test('should add provider metadata to option elements', async () => {
    getConfigStub.withArgs('models').returns(['claude-3-opus']);
    apiKeyExistsStub.withArgs('anthropic').resolves(true);
    apiKeyExistsStub.withArgs('openRouter').resolves(false);

    const result = await computeModelOptions();
    
    assert.ok(result.includes('data-provider="anthropic"'));
    assert.ok(!result.includes('disabled'));
  });

  test('should disable models without API keys', async () => {
    getConfigStub.withArgs('models').returns(['claude-3-opus']);
    apiKeyExistsStub.resolves(false);

    const result = await computeModelOptions();
    
    assert.ok(result.includes('disabled'));
    assert.ok(result.includes('(no key)'));
  });

  test('should handle provider check failures gracefully', async () => {
    getConfigStub.withArgs('models').returns(['claude-3-opus']);
    apiKeyExistsStub.rejects(new Error('API check failed'));

    const result = await computeModelOptions();
    
    assert.ok(result.includes('disabled'));
    assert.ok(result.includes('(no key)'));
  });
});