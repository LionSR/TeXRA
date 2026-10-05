#!/usr/bin/env node

/**
 * Live journey checks: the fitness function for the theorist bundle. Four
 * compile-graded journeys (polish, latexFixer, latexdiff, citations) run end to
 * end through the real `texra run ... --output-format ndjson` against each cheap
 * model in `MODEL_KEYS`, over the fixtures in `src/test-kernel/cli/fixtures/journeys/`. A
 * journey passes on simple invariants over the files it leaves behind and on a
 * real LaTeX build of them, never on how the prose reads.
 *
 * On demand only, by label or dispatch (`.github/workflows/live-journeys.yml`):
 * it spends money and needs a TeX Live. `validate-run.mjs` is the hermetic sibling
 * that runs on every PR against the canned validation model.
 *
 *   node scripts/validate-journeys.mjs [--model <ref>]... [--journey polish]...
 *     [--no-build] [--out dir]
 *
 * With no `--model` it runs every model in `MODEL_KEYS`; the workflow passes
 * none, so this map is the one list of models the journeys run.
 */

import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const cliRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const fixtureRoot = path.join(
  cliRoot,
  '../../src/test-kernel/cli/fixtures/journeys',
);
const binaryPath = path.join(cliRoot, 'dist/bin/texra.js');

/**
 * The cheap models the journeys fund (the llm-zoo 1.x `gemini38f`,
 * `deepseek41T` and `glm53flash`, spelled as the selections they stand for),
 * and the env var each is served through (`glm/glm-5.3-flash` is
 * OpenRouter-only in the catalog).
 */
const MODEL_KEYS = {
  'google/gemini-3.8-flash@medium': 'GOOGLE_API_KEY',
  'deepseek/deepseek-flash@high': 'DEEPSEEK_API_KEY',
  'glm/glm-5.3-flash@max': 'OPENROUTER_API_KEY',
};

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const read = (dir, file) => readFileSync(path.join(dir, file), 'utf8');

/** A clean latexmk build of `dir/file`; returns its log for the checks. */
function compile(dir, file) {
  const latexmk = (...args) =>
    spawnSync('latexmk', [...args, file], {
      cwd: dir,
      encoding: 'utf8',
      timeout: 120_000,
    });
  latexmk('-C');
  const build = latexmk('-pdf', '-interaction=nonstopmode', '-halt-on-error');
  const base = file.replace(/\.tex$/, '');
  assert(
    build.status === 0 && existsSync(path.join(dir, `${base}.pdf`)),
    `${file} does not compile (latexmk exit ${build.status}):\n${build.stdout.slice(-1500)}`,
  );
  return read(dir, `${base}.log`);
}

function unchanged(dir, journey, file) {
  assert(
    read(dir, file) ===
      readFileSync(path.join(fixtureRoot, journey, file), 'utf8'),
    `${file} must be left untouched`,
  );
}

const JOURNEYS = {
  polish: {
    args: ['polish', '--input', 'paper.tex', '--output', 'paper.polished.tex'],
    // The document task's result, kept with its diff against the input.
    keep: { from: 'paper.tex', to: 'paper.polished.tex' },
    instruction:
      'Replace the ASCII ellipsis with \\ldots and the straight double quotes with LaTeX quotes. Change nothing else.',
    approval: 'never',
    check(dir) {
      const out = read(dir, 'paper.polished.tex');
      assert(
        !out.includes('...') && !out.includes('"'),
        'ASCII ellipsis or straight quote survived',
      );
      assert(out.includes('\\ldots'), 'no \\ldots in the output');
      for (const kept of [
        '\\label{eq:energy}',
        '\\begin{equation}',
        '% We set $J=1$',
      ]) {
        assert(out.includes(kept), `the polish dropped ${kept}`);
      }
      compile(dir, 'paper.polished.tex');
    },
  },
  latexFixer: {
    args: ['latexFixer'],
    instruction:
      'broken.tex fails to compile. Fix it in place so that latexmk -pdf builds it without errors. Do not change the mathematics.',
    approval: 'yolo',
    check(dir) {
      compile(dir, 'broken.tex');
      const fixed = read(dir, 'broken.tex');
      assert(
        fixed.length >
          0.8 *
            readFileSync(
              path.join(fixtureRoot, 'latexFixer/broken.tex'),
              'utf8',
            ).length,
        'the fix deleted content instead of repairing it',
      );
      for (const kept of ['\\int_0^1 f(x)', 'Cauchy--Schwarz', '\\sup_{x}']) {
        assert(fixed.includes(kept), `the fix dropped ${kept}`);
      }
    },
  },
  latexdiff: {
    args: ['latexDiff'],
    instruction:
      'old.tex and new.tex are two versions of one paper. Use latexdiff to write the marked-up difference from old.tex to new.tex into diff.tex, then compile diff.tex to a PDF with latexmk. Do not modify old.tex or new.tex.',
    approval: 'yolo',
    check(dir) {
      const diff = read(dir, 'diff.tex');
      assert(
        diff.includes('\\DIFadd{') && diff.includes('\\DIFdel{'),
        'diff.tex carries no latexdiff addition and deletion markup',
      );
      compile(dir, 'diff.tex');
      unchanged(dir, 'latexdiff', 'old.tex');
      unchanged(dir, 'latexdiff', 'new.tex');
    },
  },
  citations: {
    args: ['latexFixer'],
    instruction:
      'paper.tex cites a key that refs.bib does not define. Build it with latexmk -pdf and fix the citation so every \\cite resolves. Do not add, remove or edit any entry in refs.bib.',
    approval: 'yolo',
    check(dir) {
      const log = compile(dir, 'paper.tex');
      assert(
        !/Citation `[^']*' .*undefined|There were undefined (citations|references)/.test(
          log,
        ),
        'an undefined citation remains in the build log',
      );
      assert(
        read(dir, 'paper.tex').includes('\\cite{einstein1905relativity}'),
        'the einstein1905 citation was not pointed at its refs.bib entry',
      );
      unchanged(dir, 'citations', 'refs.bib');
    },
  },
};

/** Run one journey through the real CLI; returns `{ tokens, cost }` or throws. */
function runJourney(name, model, outDir) {
  const journey = JOURNEYS[name];
  const dir = mkdtempSync(path.join(tmpdir(), `texra-journey-${name}-`));
  const home = mkdtempSync(path.join(tmpdir(), `texra-journey-${name}-home-`));
  try {
    cpSync(path.join(fixtureRoot, name), dir, { recursive: true });
    const keyEnv = MODEL_KEYS[model];
    const texra = (args, timeout) =>
      spawnSync(process.execPath, [binaryPath, ...args, '--cwd', dir], {
        cwd: dir,
        encoding: 'utf8',
        timeout,
        maxBuffer: 64 * 1024 * 1024,
        // yolo runs the fixer's bash unattended, so the child sees this one
        // provider key and nothing else from the runner's environment.
        env: {
          PATH: process.env.PATH,
          HOME: home,
          XDG_CONFIG_HOME: path.join(home, '.config'),
          XDG_DATA_HOME: path.join(home, '.local/share'),
          XDG_STATE_HOME: path.join(home, '.local/state'),
          XDG_CACHE_HOME: path.join(home, '.cache'),
          TEXRA_NO_UPDATE_CHECK: '1',
          CI: '1',
          [keyEnv]: process.env[keyEnv],
        },
      });
    // A fresh home enables only the curated default models; `--model` runs
    // enabled ones only.
    const enable = texra(['models', 'enable', model], 60_000);
    assert(enable.status === 0, `texra models enable ${model} failed`);
    const result = texra(
      [
        'run',
        ...journey.args,
        '--instruction',
        journey.instruction,
        '--model',
        model,
        '--approval-policy',
        journey.approval,
        '--output-format',
        'ndjson',
      ],
      300_000,
    );
    const stem = path.join(
      outDir,
      `${name}.${model.replaceAll(/[^\w.-]/g, '-')}`,
    );
    writeFileSync(`${stem}.ndjson`, result.stdout ?? '');
    writeFileSync(`${stem}.stderr`, result.stderr ?? '');
    assert(
      result.status === 0,
      `texra run exited ${result.status}${result.signal ? ` (${result.signal})` : ''}:\n${(result.stderr ?? '').slice(-1500)}`,
    );

    const records = result.stdout
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line));
    const contract = records[0]?.contract;
    assert(
      records.every(
        (r) => typeof r.kind === 'string' && r.contract === contract,
      ),
      'NDJSON records must all carry a kind and one contract version',
    );
    const final = records.at(-1);
    assert(
      final?.kind === 'result' || final?.kind === 'agent-result',
      `the last NDJSON record is ${final?.kind}, not a result`,
    );
    assert(
      final.result.outcome === 'completed',
      `run outcome is ${final.result.outcome}`,
    );

    if (journey.keep) {
      const { from, to } = journey.keep;
      cpSync(path.join(dir, to), `${stem}.${to}`);
      const diff = spawnSync('diff', ['-u', from, to], {
        cwd: dir,
        encoding: 'utf8',
      });
      writeFileSync(`${stem}.diff`, diff.stdout ?? '');
    }
    journey.check(dir);
    const { totalInputTokens, totalOutputTokens, totalCost } =
      final.result.usage;
    return { tokens: totalInputTokens + totalOutputTokens, cost: totalCost };
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
}

const { values } = parseArgs({
  options: {
    model: { type: 'string', multiple: true },
    journey: { type: 'string', multiple: true },
    'no-build': { type: 'boolean', default: false },
    out: { type: 'string', default: path.join(cliRoot, 'dist/journeys') },
  },
});

const models = values.model ?? Object.keys(MODEL_KEYS);
const unknownModels = models.filter((model) => !(model in MODEL_KEYS));
if (unknownModels.length > 0) {
  console.error(
    `[journeys] unknown model: ${unknownModels.join(', ')}; --model must be one of ${Object.keys(MODEL_KEYS).join(', ')}`,
  );
  process.exit(2);
}
const names = values.journey ?? Object.keys(JOURNEYS);
const unknown = names.filter((name) => !(name in JOURNEYS));
if (unknown.length > 0) {
  console.error(`[journeys] unknown journey: ${unknown.join(', ')}`);
  process.exit(2);
}
const funded = models.filter((model) => {
  if (process.env[MODEL_KEYS[model]]) return true;
  console.warn(`[journeys] ${MODEL_KEYS[model]} is not set: skipping ${model}`);
  return false;
});
// Every CI run was asked for (label or dispatch), so a missing key must not
// leave it green; a local run only warns and skips that model.
const missingKeyFails =
  funded.length < models.length && process.env.GITHUB_ACTIONS === 'true';
if (funded.length === 0) process.exit(missingKeyFails ? 1 : 0);

if (!values['no-build']) {
  for (const script of ['build-bundle.mjs', 'copy-resources.mjs']) {
    const build = spawnSync(process.execPath, [path.join('scripts', script)], {
      cwd: cliRoot,
      stdio: 'inherit',
    });
    assert(build.status === 0, `scripts/${script} failed`);
  }
}
mkdirSync(values.out, { recursive: true });

let failed = missingKeyFails;
for (const model of funded) {
  const rows = names.map((name) => {
    try {
      return { name, ...runJourney(name, model, values.out) };
    } catch (error) {
      return {
        name,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });
  const lines = rows.map((row) =>
    row.error
      ? `FAIL ${row.name} (${model}): ${row.error}`
      : `PASS ${row.name} (${model}): ${row.tokens} tokens, $${row.cost.toFixed(5)}`,
  );
  console.log(lines.join('\n'));
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `### Journeys on ${model}\n\n\`\`\`\n${lines.join('\n')}\n\`\`\`\n`,
    );
  }
  failed ||= rows.some((row) => row.error);
}
process.exit(failed ? 1 : 0);
