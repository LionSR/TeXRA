// Native CLI regression, entirely synthetic: build with npm run texra-local:build,
// then run node packages/cli/scripts/validate-google-stateless.cjs.
// Artifacts remain in packages/desktop/tests/e2e/test-results/google-stateless/.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

module.exports = (request, response) => {
  let body = '';
  request.setEncoding('utf8');
  request.on('data', (chunk) => (body += chunk));
  request.on('end', () => {
    const input = JSON.parse(body);
    const store = process.env.TEXRA_SMOKE_STORE === 'true';
    assert.equal(request.method, 'POST');
    assert.match(request.url, /\/interactions$/);
    assert.equal(input.store, store);
    assert.equal(input.stream, true);
    assert.equal(input.background, false);
    assert.equal(input.previous_interaction_id, undefined);
    const id = store ? 'int_synthetic_smoke' : '';
    const events = [
      {
        event_type: 'interaction.created',
        interaction: { id, model: input.model },
      },
      { event_type: 'step.start', index: 0, step: { type: 'model_output' } },
      {
        event_type: 'step.delta',
        index: 0,
        delta: { type: 'text', text: 'Synthetic CLI response.' },
      },
      { event_type: 'step.stop', index: 0 },
      {
        event_type: 'interaction.completed',
        interaction: {
          id,
          status: 'completed',
          usage: {
            total_input_tokens: 3,
            total_output_tokens: 2,
            total_tokens: 5,
          },
        },
      },
    ];
    fs.appendFileSync(
      process.env.TEXRA_SMOKE_REQUESTS,
      JSON.stringify({
        store: input.store,
        stream: input.stream,
        background: input.background,
      }) + '\n',
    );
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(
      events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''),
    );
  });
};

if (require.main === module) {
  void (async () => {
    const { isolateProcessHome, isolatedHomeEnv } =
      await import('../../../scripts/isolated-home.mjs');
    const isolatedRoot = isolateProcessHome();
    const root = path.resolve(__dirname, '../../..');
    const artifacts = path.join(
      root,
      'packages/desktop/tests/e2e/test-results/google-stateless',
    );
    fs.mkdirSync(artifacts, { recursive: true });
    for (const store of [false, true]) {
      const label = store ? 'stored' : 'stateless';
      const isolated = path.join(isolatedRoot, label);
      const globalStorage = path.join(isolated, '.texra/v1/global-storage');
      const work = path.join(artifacts, label);
      fs.mkdirSync(work, { recursive: true });
      fs.mkdirSync(path.join(globalStorage, 'custom_agents'), {
        recursive: true,
      });
      fs.writeFileSync(
        path.join(globalStorage, 'config.json'),
        JSON.stringify({
          'texra.model.useGoogleInteractionsServerState': store,
          'texra.model.retry.maxAttempts': 0,
          'texra.model.compactionThresholdPercent': 0,
        }),
      );
      fs.writeFileSync(
        path.join(globalStorage, 'custom_agents/synthetic.yaml'),
        'name: synthetic\ndescription: Synthetic protocol smoke.\ntools: []\nprompt: Respond with a short sentence.\n',
      );
      const requests = path.join(work, 'requests.ndjson');
      fs.writeFileSync(requests, '');
      const result = spawnSync(
        process.execPath,
        [
          path.join(root, 'packages/cli/dist/bin/texra.js'),
          'run',
          'synthetic',
          '--cwd',
          work,
          '--model',
          'google/gemini-4-argon',
          '--instruction',
          'Synthetic text-only CLI smoke.',
          '--print',
          '--output-format',
          'ndjson',
          '--no-input',
          '--approval-policy',
          'never',
          '--no-color',
        ],
        {
          cwd: root,
          env: {
            PATH: process.env.PATH,
            ...isolatedHomeEnv(isolated),
            CI: '1',
            GOOGLE_API_KEY: 'synthetic-key',
            TEXRA_NO_UPDATE_CHECK: '1',
            TEXRA_NO_TELEMETRY: '1',
            TEXRA_NO_SERVICE: '1',
            NODE_OPTIONS: `--require ${path.join(__dirname, 'fake-provider-tls.cjs')}`,
            TEXRA_FAKE_HOSTS: 'generativelanguage.googleapis.com',
            TEXRA_FAKE_HANDLER: __filename,
            TEXRA_SMOKE_STORE: String(store),
            TEXRA_SMOKE_REQUESTS: requests,
          },
          encoding: 'utf8',
          timeout: 60000,
          maxBuffer: 8 * 1024 * 1024,
        },
      );
      fs.writeFileSync(
        path.join(work, 'transcript.ndjson'),
        result.stdout ?? '',
      );
      fs.writeFileSync(path.join(work, 'stderr.txt'), result.stderr ?? '');
      assert.equal(result.status, 0, result.stderr || result.stdout);
      const transcript = result.stdout.trim().split('\n').map(JSON.parse);
      const final = transcript.findLast(
        (event) => event.kind === 'agent-result',
      );
      assert.equal(final.result.outcome, 'completed');
      assert.equal(final.result.output.response, 'Synthetic CLI response.');
      const storage = path.join(isolated, '.texra/v1/workspace-storage');
      const projects = fs.readdirSync(storage);
      assert.equal(projects.length, 1);
      const database = new DatabaseSync(
        path.join(storage, projects[0], 'texra.db'),
        { readOnly: true },
      );
      try {
        const responses = database
          .prepare("SELECT data FROM event WHERE type = 'model.message'")
          .all()
          .map((row) => JSON.parse(row.data).payload)
          .filter((payload) => payload.kind === 'response');
        assert.equal(responses.length, 1);
        const turn = responses[0].turn;
        assert.equal(
          turn.providerResponseId,
          store ? 'int_synthetic_smoke' : null,
        );
        assert.equal(turn.continuation !== undefined, store);
        assert.deepEqual(turn.content, [
          {
            kind: 'message',
            content: [{ kind: 'text', text: 'Synthetic CLI response.' }],
          },
        ]);
        fs.writeFileSync(
          path.join(work, 'saved-turn.json'),
          JSON.stringify(turn, null, 2) + '\n',
        );
      } finally {
        database.close();
      }
      const sent = fs
        .readFileSync(requests, 'utf8')
        .trim()
        .split('\n')
        .map(JSON.parse);
      assert.deepEqual(sent, [{ store, stream: true, background: false }]);
      console.log(
        `${label}: native CLI response saved to ${path.relative(root, work)}`,
      );
    }
  })().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
