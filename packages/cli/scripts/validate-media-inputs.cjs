// Offline native-CLI regression: npm run texra-local:build, then
// node packages/cli/scripts/validate-media-inputs.cjs.
// Failure modes: binary inputs decoded as text, dropped or altered audio,
// lost ordinary text, media attached only to the first document revision,
// conversational media resolved in run storage before being mirrored,
// or media mistaken for an edited output or a text-file instruction.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

// 0.1 seconds of generated silence, AAC in an M4A container. No user audio.
const AUDIO = Buffer.from(
  'AAAAHGZ0eXBNNEEgAAACAE00QSBpc29taXNvMgAAAwJtb292AAAAbG12aGQAAAAAAAAAAAAAAAAAAB9AAAADIAABAAABAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAACLXRyYWsAAABcdGtoZAAAAAMAAAAAAAAAAAAAAAEAAAAAAAADIAAAAAAAAAAAAAAAAQEAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAACRlZHRzAAAAHGVsc3QAAAAAAAAAAQAAAyAAAAQAAAEAAAAAAaVtZGlhAAAAIG1kaGQAAAAAAAAAAAAAAAAAAB9AAAAHIFXEAAAAAAAtaGRscgAAAAAAAAAAc291bgAAAAAAAAAAAAAAAFNvdW5kSGFuZGxlcgAAAAFQbWluZgAAABBzbWhkAAAAAAAAAAAAAAAkZGluZgAAABxkcmVmAAAAAAAAAAEAAAAMdXJsIAAAAAEAAAEUc3RibAAAAGpzdHNkAAAAAAAAAAEAAABabXA0YQAAAAAAAAABAAAAAAAAAAAAAQAQAAAAAB9AAAAAAAA2ZXNkcwAAAAADgICAJQABAASAgIAXQBUAAAAAALuAAAADJwWAgIAFFYhW5QAGgICAAQIAAAAgc3R0cwAAAAAAAAACAAAAAQAABAAAAAABAAADIAAAABxzdHNjAAAAAAAAAAEAAAABAAAAAgAAAAEAAAAcc3RzegAAAAAAAAAAAAAAAgAAABMAAAAEAAAAFHN0Y28AAAAAAAAAAQAAAy4AAAAac2dwZAEAAAByb2xsAAAAAgAAAAH//wAAABxzYmdwAAAAAHJvbGwAAAABAAAAAgAAAAEAAABhdWR0YQAAAFltZXRhAAAAAAAAACFoZGxyAAAAAAAAAABtZGlyYXBwbAAAAAAAAAAAAAAAACxpbHN0AAAAJKl0b28AAAAcZGF0YQAAAAEAAAAATGF2ZjYzLjEuMTAyAAAACGZyZWUAAAAfbWRhdNwATGF2YzYzLjEuMTAyAAIwQA4BGCAH',
  'base64',
);
const NOTE = 'Synthetic text: keep the equation x + y = z and café unchanged.';
const DOCUMENT =
  '\\documentclass{article}\n\\begin{document}\nSynthetic result.\n\\end{document}\n';
const EDIT_INPUT = DOCUMENT.replace('Synthetic result.', NOTE);

module.exports = (request, response) => {
  let body = '';
  request.setEncoding('utf8');
  request.on('data', (chunk) => (body += chunk));
  request.on('end', () => {
    const input = JSON.parse(body);
    assert.match(request.url, /\/interactions$/);
    fs.appendFileSync(
      process.env.TEXRA_MEDIA_REQUESTS,
      JSON.stringify(input) + '\n',
    );
    const text =
      process.env.TEXRA_MEDIA_CHAT === 'true'
        ? 'Synthetic result.'
        : `<documents>${(process.env.TEXRA_MEDIA_FILENAME ?? 'transcript.tex')
            .split(',')
            .map((name) => `<document name="${name}">${DOCUMENT}</document>`)
            .join('')}</documents>`;
    const events = [
      {
        event_type: 'interaction.created',
        interaction: { id: 'int_fixture', model: input.model },
      },
      { event_type: 'step.start', index: 0, step: { type: 'model_output' } },
      { event_type: 'step.delta', index: 0, delta: { type: 'text', text } },
      { event_type: 'step.stop', index: 0 },
      {
        event_type: 'interaction.completed',
        interaction: {
          id: 'int_fixture',
          status: 'completed',
          usage: {
            total_input_tokens: 3,
            total_output_tokens: 2,
            total_tokens: 5,
          },
        },
      },
    ];
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
    const home = isolateProcessHome();
    const root = path.resolve(__dirname, '../../..');
    const artifacts = path.join(
      root,
      'packages/desktop/tests/e2e/test-results/media-inputs',
    );
    const globalStorage = path.join(home, '.texra/v1/global-storage');
    fs.mkdirSync(path.join(globalStorage, 'custom_agents'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(globalStorage, 'config.json'),
      JSON.stringify({
        'texra.model.useGoogleInteractionsServerState': false,
        'texra.model.retry.maxAttempts': 0,
        'texra.model.compactionThresholdPercent': 0,
      }),
    );
    fs.writeFileSync(
      path.join(globalStorage, 'custom_agents/synthetic_document.yaml'),
      'name: synthetic_document\ndescription: Synthetic document smoke.\ntools: []\nprompt: Produce the requested document.\ntask:\n  outputs: [transcript.tex]\n  prefix: "{{ ALL_INPUTS }}"\n  requests: ["Write the document.", "Check the document."]\n',
    );
    fs.writeFileSync(
      path.join(globalStorage, 'custom_agents/synthetic_chat.yaml'),
      'name: synthetic_chat\ndescription: Synthetic chat smoke.\ntools: []\nprompt: Produce a short response.\n',
    );
    fs.writeFileSync(
      path.join(globalStorage, 'custom_agents/synthetic_edit.yaml'),
      'name: synthetic_edit\ndescription: Synthetic edit smoke.\ntools: []\nprompt: Revise the document.\ntask:\n  prefix: "{{ ALL_INPUTS }}"\n  requests: ["Revise the document.", "Check the document."]\n',
    );
    fs.writeFileSync(
      path.join(globalStorage, 'custom_agents/synthetic_multi.yaml'),
      'name: synthetic_multi\ndescription: Synthetic multi-output smoke.\ntools: []\nprompt: Produce the requested documents.\ntask:\n  outputs: [first.tex, second.tex]\n  prefix: "{{ ALL_INPUTS }}"\n  requests: ["Write both documents.", "Check both documents."]\n',
    );
    for (const scenario of [
      {
        name: 'audio',
        agent: 'transcribe_audio',
        files: ['silence.M4A'],
        audio: true,
        note: false,
        calls: 2,
      },
      {
        name: 'text',
        agent: 'synthetic_document',
        files: ['notes.txt'],
        audio: false,
        note: true,
        calls: 2,
      },
      {
        name: 'mixed',
        agent: 'transcribe_audio',
        files: ['silence.M4A', 'notes.txt'],
        audio: true,
        note: true,
        calls: 2,
      },
      {
        name: 'chat',
        agent: 'synthetic_chat',
        files: ['silence.M4A', 'notes.txt'],
        audio: true,
        note: false,
        calls: 1,
      },
      {
        name: 'edit-file',
        agent: 'synthetic_edit',
        files: ['paper.tex', 'silence.M4A'],
        audio: true,
        note: true,
        calls: 2,
      },
      {
        name: 'edit-dir',
        agent: 'synthetic_edit',
        files: ['paper.tex', 'silence.M4A'],
        audio: true,
        note: true,
        calls: 2,
      },
      {
        name: 'stdin-audio',
        agent: 'synthetic_document',
        files: ['-', 'silence.M4A'],
        audio: true,
        note: true,
        calls: 2,
      },
      {
        name: 'stdin-glob',
        agent: 'synthetic_document',
        files: ['-', 'silence.*'],
        audio: true,
        note: true,
        calls: 2,
      },
      {
        name: 'multi-output',
        agent: 'synthetic_multi',
        files: ['paper.tex', 'silence.M4A'],
        reject: true,
      },
    ].filter((entry) => !process.argv[2] || entry.name === process.argv[2])) {
      const work = path.join(artifacts, scenario.name);
      fs.rmSync(work, { recursive: true, force: true });
      fs.mkdirSync(work, { recursive: true });
      fs.writeFileSync(path.join(work, 'silence.M4A'), AUDIO);
      fs.writeFileSync(path.join(work, 'notes.txt'), NOTE);
      fs.writeFileSync(path.join(work, 'paper.tex'), EDIT_INPUT);
      const requests = path.join(work, 'requests.ndjson');
      fs.writeFileSync(requests, '');
      const result = spawnSync(
        process.execPath,
        [
          path.join(root, 'packages/cli/dist/bin/texra.js'),
          'run',
          scenario.agent,
          '--cwd',
          work,
          ...scenario.files.flatMap((file) => ['--input', file]),
          ...(['audio', 'stdin-audio', 'stdin-glob', 'multi-output'].includes(
            scenario.name,
          )
            ? ['--output', 'transcript.tex']
            : []),
          ...(scenario.name === 'edit-file' ? ['--output', 'edited.tex'] : []),
          ...(['mixed', 'edit-dir'].includes(scenario.name)
            ? ['--output-dir', 'delivered']
            : []),
          '--instruction',
          'Return the synthetic result.',
          '--model',
          'google/gemini-4-argon@low',
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
          encoding: 'utf8',
          input: scenario.files.includes('-') ? NOTE : undefined,
          timeout: 60000,
          maxBuffer: 8 * 1024 * 1024,
          env: {
            PATH: process.env.PATH,
            ...isolatedHomeEnv(home),
            CI: '1',
            GOOGLE_API_KEY: 'synthetic-key',
            TEXRA_NO_UPDATE_CHECK: '1',
            TEXRA_NO_TELEMETRY: '1',
            TEXRA_NO_SERVICE: '1',
            NODE_OPTIONS: `--require ${path.join(__dirname, 'fake-provider-tls.cjs')}`,
            TEXRA_FAKE_HOSTS: 'generativelanguage.googleapis.com',
            TEXRA_FAKE_HANDLER: __filename,
            TEXRA_MEDIA_REQUESTS: requests,
            TEXRA_MEDIA_CHAT: String(scenario.name === 'chat'),
            TEXRA_MEDIA_FILENAME:
              scenario.agent === 'synthetic_multi'
                ? 'first.tex,second.tex'
                : scenario.agent === 'synthetic_edit'
                  ? 'paper.tex'
                  : 'transcript.tex',
          },
        },
      );
      fs.writeFileSync(
        path.join(work, 'transcript.ndjson'),
        result.stdout ?? '',
      );
      fs.writeFileSync(path.join(work, 'stderr.txt'), result.stderr ?? '');
      if (scenario.reject) {
        assert.equal(
          result.status,
          2,
          'multiple declared outputs require --output-dir',
        );
        assert.match(result.stderr, /single final artifact/);
        assert.equal(
          fs.readFileSync(requests, 'utf8'),
          '',
          'reject before model work',
        );
        assert(!fs.existsSync(path.join(work, 'transcript.tex')));
        console.log(
          `${scenario.name}: native CLI rejected before provider work`,
        );
        continue;
      }
      assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
      const turns = fs
        .readFileSync(requests, 'utf8')
        .trim()
        .split('\n')
        .map(JSON.parse);
      assert.equal(
        turns.length,
        scenario.calls,
        `${scenario.name}: request count`,
      );
      for (const turn of turns) {
        assert.equal(turn.store, false);
        const content = turn.input.flatMap((step) => step.content ?? []);
        const audio = content.filter((part) => part.type === 'audio');
        assert.equal(
          audio.length,
          Number(scenario.audio),
          `${scenario.name}: audio attachment count`,
        );
        if (scenario.audio) {
          assert.equal(audio[0].mime_type, 'audio/mp4');
          assert.deepEqual(Buffer.from(audio[0].data, 'base64'), AUDIO);
        }
        const text = content
          .filter((part) => part.type === 'text')
          .map((part) => part.text)
          .join('\n');
        assert(
          !text.includes('ftypM4A'),
          `${scenario.name}: binary data entered the prompt`,
        );
        assert(
          Buffer.byteLength(text) < 12000,
          `${scenario.name}: oversized prompt`,
        );
        if (scenario.name === 'chat') {
          assert(text.includes('notes.txt'));
          assert(
            !text.includes('silence.M4A'),
            'media is not a text-file instruction',
          );
        }
        if (scenario.note)
          assert(
            text.includes(NOTE),
            `${scenario.name}: ordinary text changed or lost`,
          );
      }
      const records = result.stdout.trim().split('\n').map(JSON.parse);
      const completed = records.findLast(
        (record) => record.kind === 'result' || record.kind === 'agent-result',
      ).result;
      assert.equal(completed.outcome, 'completed');
      if (scenario.name === 'chat')
        assert.equal(completed.output.response, 'Synthetic result.');
      else {
        const output = completed.output.documents.outputs[0].absolutePath;
        assert.equal(fs.readFileSync(output, 'utf8'), DOCUMENT);
        fs.copyFileSync(output, path.join(work, 'result.tex'));
        if (['audio', 'stdin-audio', 'stdin-glob'].includes(scenario.name))
          assert.equal(
            fs.readFileSync(path.join(work, 'transcript.tex'), 'utf8'),
            DOCUMENT,
          );
        if (scenario.name === 'mixed')
          assert.equal(
            fs.readFileSync(
              path.join(work, 'delivered/transcript.tex'),
              'utf8',
            ),
            DOCUMENT,
          );
        if (scenario.name === 'edit-file')
          assert.equal(
            fs.readFileSync(path.join(work, 'edited.tex'), 'utf8'),
            DOCUMENT,
          );
        if (scenario.name === 'edit-dir')
          assert.equal(
            fs.readFileSync(path.join(work, 'delivered/paper.tex'), 'utf8'),
            DOCUMENT,
          );
      }
      const storage = path.join(home, '.texra/v1/workspace-storage');
      const project = fs
        .readdirSync(storage)
        .find((name) => name.startsWith(`${scenario.name}-`));
      assert(project, 'native project store exists');
      const db = new DatabaseSync(path.join(storage, project, 'texra.db'), {
        readOnly: true,
      });
      const configs = db
        .prepare("SELECT version, data FROM event WHERE type = 'run.config'")
        .all();
      db.close();
      assert(configs.length > 0);
      assert(configs.every((row) => row.version === 4));
      fs.writeFileSync(
        path.join(work, 'saved-configs.json'),
        JSON.stringify(configs, null, 2) + '\n',
      );
      assert.deepEqual(fs.readFileSync(path.join(work, 'silence.M4A')), AUDIO);
      assert.equal(fs.readFileSync(path.join(work, 'notes.txt'), 'utf8'), NOTE);
      assert.equal(
        fs.readFileSync(path.join(work, 'paper.tex'), 'utf8'),
        EDIT_INPUT,
      );
      console.log(
        `${scenario.name}: native CLI verified; artifacts in ${path.relative(root, work)}`,
      );
    }
  })().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
