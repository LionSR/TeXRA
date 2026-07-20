export const meta = {
  name: 'tech-debt-tournament',
  description:
    'Recurring tech-debt tournament: seam mappers over a ROTATING slice of areas, architect lenses propose deletions, dedupe against known issues + do-not-do ledger, adversarial net-gain verification, output capped to a few issues per cycle.',
  whenToUse:
    'Invoked by the tech-debt-tournament skill (scheduled campaign). Args: { campaignDate, cursor?, rotationSize?, knownIssues?, doNotDo?, areas?, maxVerify?, maxFile? }. Deliberately scoped small per run (a handful of areas, a few issues filed) — breadth comes from repeated cycles rotating through areas, not from one large sweep.',
  phases: [
    { title: 'Map', detail: 'one read-only seam mapper per rotated area' },
    { title: 'Propose', detail: 'four architect lenses over all maps' },
    { title: 'Dedupe', detail: 'merge + drop known issues and adjudicated do-not-dos' },
    { title: 'Verify', detail: 'three adversarial refuters per candidate; majority refute kills' },
  ],
}

// The driver (skill) passes campaignDate because Date is unavailable inside workflow scripts.
const campaignDate = (args && args.campaignDate) || 'unknown-date'
const knownIssues = (args && args.knownIssues) || [] // ["#8746 refactor(logger): ...", ...]
const doNotDo = (args && args.doNotDo) || [] // ledger entries: adjudicated NET_LOSS / held-back items
const MAX_VERIFY = (args && args.maxVerify) || 8
// Hard cap on issues actually recommended for filing this cycle. Keep this small —
// the point of running every few days is a steady trickle, not another 12-issue/-1k-LoC
// mega campaign each time. Extra REAL_NET_GAIN survivors are returned as carriedForward,
// not filed, so they aren't lost but also don't overshoot this cycle.
const MAX_FILE = (args && args.maxFile) || 3

const ALL_AREAS = [
  { name: 'agent-runtime', paths: ['src/agent/runtime/', 'src/agent/core/'] },
  { name: 'model-handlers', paths: ['src/agent/modelHandlers/', 'src/model/'] },
  { name: 'flows-tools', paths: ['src/agent/implementations/', 'src/tools/'] },
  { name: 'platform-infra', paths: ['src/platform/', 'src/logger/', 'src/eventBus/', 'src/utils/'] },
  { name: 'storage-transcript', paths: ['src/agent/storage/', 'src/agent/trace/', 'src/transcript/'] },
  { name: 'controllers-shared', paths: ['src/controllers/', 'src/shared/', 'src/hosts/'] },
  { name: 'extension-host', paths: ['packages/extension/src/commands/', 'packages/extension/src/*.ts'] },
  { name: 'webviews', paths: ['packages/extension/src/webview/', 'packages/extension/src/progressView/', 'packages/extension/src/settingsView/'] },
  { name: 'cli', paths: ['packages/cli/src/'] },
  { name: 'desktop', paths: ['packages/desktop/src/'] },
]

// Rotate a small slice of areas per cycle instead of sweeping the whole repo every run.
// The driving skill persists `cursor` (a GitHub ledger issue) and advances it by
// rotationSize each cycle, so full coverage happens over several cycles, not one.
function rotateAreas(all, cursor, size) {
  const start = ((cursor % all.length) + all.length) % all.length
  const picked = []
  for (let i = 0; i < Math.min(size, all.length); i++) picked.push(all[(start + i) % all.length])
  return picked
}

const rotationSize = (args && args.rotationSize) || 3
const cursor = (args && args.cursor) || 0
const areas = (args && args.areas) || rotateAreas(ALL_AREAS, cursor, rotationSize)

const SEAM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    area: { type: 'string' },
    seams: {
      type: 'array',
      maxItems: 15,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: {
            type: 'string',
            enum: [
              'pass-through',
              'dead-or-vestigial',
              'ritual',
              'duplicated-pipeline',
              'legacy-arm',
              'single-caller-helper',
              'coupling-violation',
              'config-never-set',
              'other',
            ],
          },
          what: { type: 'string', description: 'one sentence: the seam and why it smells' },
          evidence: { type: 'string', description: 'file:line citations plus the grep/git command that proves it' },
          estLoc: { type: 'number', description: 'estimated LoC removable (positive number)' },
        },
        required: ['kind', 'what', 'evidence', 'estLoc'],
      },
    },
    healthy: { type: 'string', description: 'what you checked that is clean, so lenses do not waste time there' },
  },
  required: ['area', 'seams', 'healthy'],
}

function mapperPrompt(area) {
  return [
    `READ-ONLY seam-mapping task on the TeXRA repo (tech-debt tournament ${campaignDate}). DO NOT EDIT ANY FILE; run no state-changing commands.`,
    ``,
    `Map tech-debt seams in the "${area.name}" area: ${area.paths.join(', ')}`,
    ``,
    `Hunt for, with hard evidence (file:line, caller counts via ripgrep, LoC via wc/awk):`,
    `- pass-throughs and one-call factories (the repo's abstraction-cost guardrails in CLAUDE.md/AGENTS.md)`,
    `- dead or vestigial code: exports with zero callers, config knobs never set, feature arms never taken`,
    `- rituals: call sites that all invoke something whose body is a no-op or already-lazy (e.g. the deleted logger.initialize ritual, #8746)`,
    `- duplicated pipelines: the same concept implemented N times where one implementation could serve`,
    `- legacy arms: dual-write/dual-read paths, migration leftovers, deprecated formats still branched on`,
    `- coupling violations: vscode imports or host leakage inside VS Code-free zones (see CLAUDE.md list)`,
    ``,
    `Rules: max 15 seams, quality over quantity, each needs verifiable evidence you actually collected (run the greps; do not estimate from memory). Prefer deletion-shaped findings — the campaign currency is negative LoC and removed named elements. Note explicitly what you checked and found healthy.`,
  ].join('\n')
}

const CANDIDATE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    lens: { type: 'string' },
    candidates: {
      type: 'array',
      maxItems: 8,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string', description: 'issue-style title: refactor(scope): <what ceases to exist> (~-N LoC)' },
          spec: { type: 'string', description: 'the full work spec: what ceases to exist (exact symbols/files), why zero or acceptable observable change, sequencing constraints' },
          estLoc: { type: 'number', description: 'estimated net LoC removed (positive number)' },
          estElements: { type: 'number', description: 'estimated named elements removed' },
          risk: { type: 'string', enum: ['low', 'medium', 'high'] },
          files: { type: 'array', items: { type: 'string' } },
          area: { type: 'string' },
        },
        required: ['title', 'spec', 'estLoc', 'estElements', 'risk', 'files', 'area'],
      },
    },
  },
  required: ['lens', 'candidates'],
}

const LENSES = [
  {
    key: 'deletion-first',
    brief:
      'What can simply cease to exist? Favor candidates where the fix is deletion plus mechanical call-site cleanup, no replacement machinery. Reject anything whose "fix" adds a new abstraction.',
  },
  {
    key: 'abstraction-cost',
    brief:
      'Apply the repo abstraction-cost guardrails: single-caller extractions, identity factories, pass-through layers, ports/facades that never earned a second implementation. Each candidate must name the caller-count grep that proves it.',
  },
  {
    key: 'duplication',
    brief:
      'Same concept implemented N times (pipelines, encodings, vocabularies, state shapes). Only propose unification when one existing implementation can absorb the others with net-negative LoC — never a new third implementation.',
  },
  {
    key: 'legacy-retirement',
    brief:
      'Dual-write/dual-read arms, migration leftovers, deprecated formats, decision reversals whose losing branch still ships. Candidates must state the compatibility story (persisted data, resume paths, headless parity).',
  },
]

function lensPrompt(lens, mapsJson) {
  return [
    `READ-ONLY architect task on the TeXRA repo (tech-debt tournament ${campaignDate}). DO NOT EDIT ANY FILE.`,
    ``,
    `Lens: ${lens.key}. ${lens.brief}`,
    ``,
    `Below are seam maps produced by per-area mappers this run. Turn the strongest seams matching your lens into concrete, issue-ready deletion/refactor candidates. Re-verify every citation in the actual source before including it — mappers can be wrong, and a candidate with unverified evidence is worthless. You may also add candidates the mappers missed, if you verify them yourself.`,
    ``,
    `Seam maps:`,
    mapsJson,
    ``,
    `Bar for inclusion: net LoC strictly negative after accounting for replacement code; behavior-preserving (or the behavior change is spelled out and trivially acceptable); spec concrete enough that an implementer needs no further discovery. Max 8 candidates; fewer strong ones beat many weak ones. Zero candidates is a valid answer.`,
  ].join('\n')
}

const DEDUPE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kept: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string' },
          spec: { type: 'string' },
          estLoc: { type: 'number' },
          estElements: { type: 'number' },
          risk: { type: 'string', enum: ['low', 'medium', 'high'] },
          files: { type: 'array', items: { type: 'string' } },
          area: { type: 'string' },
        },
        required: ['title', 'spec', 'estLoc', 'estElements', 'risk', 'files', 'area'],
      },
    },
    droppedAsKnown: { type: 'array', items: { type: 'string' }, description: 'candidate title -> which known issue it duplicates' },
    droppedAsDoNotDo: { type: 'array', items: { type: 'string' }, description: 'candidate title -> which ledger entry bans it' },
    merged: { type: 'array', items: { type: 'string' }, description: 'notes on candidates merged into one' },
  },
  required: ['kept', 'droppedAsKnown', 'droppedAsDoNotDo', 'merged'],
}

const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    refuted: { type: 'boolean' },
    confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
    reason: { type: 'string' },
    corrections: {
      type: 'string',
      description: 'scope corrections an implementer MUST honor even if the candidate survives (e.g. "the 78-hit grep includes one doc comment"). Empty string if none.',
    },
  },
  required: ['refuted', 'confidence', 'reason', 'corrections'],
}

const REFUTER_LENSES = [
  {
    key: 'net-loc',
    brief:
      'Attack the accounting. Recount callers with your own greps, price the replacement code honestly, include test churn. Refute if net LoC is not clearly negative or the element count is inflated.',
  },
  {
    key: 'behavior-risk',
    brief:
      'Attack behavior preservation. Hunt for observable changes: persisted formats, resume/compatibilityKey paths, headless parity (texra run / --print byte-identical), webview contracts, error surfaces. Refute if any unaccounted observable change exists.',
  },
  {
    key: 'load-bearing-precedent',
    brief:
      'Attack the premise. Is the indirection a contract (Platform port, PocketFlow hook, test seam)? Was this tried and reverted (search git log), or adjudicated in docs/proposals or the do-not-do ledger? Refute if the seam is load-bearing or previously rejected.',
  },
]

function refuterPrompt(candidate, lens) {
  return [
    `READ-ONLY adversarial verification on the TeXRA repo. DO NOT EDIT ANY FILE. Your job is to REFUTE this tech-debt candidate; it only ships if it survives you. Default to refuted=true when uncertain.`,
    ``,
    `Refutation lens: ${lens.key}. ${lens.brief}`,
    ``,
    `Candidate: ${candidate.title}`,
    `Claimed: ~-${candidate.estLoc} LoC, -${candidate.estElements} elements, risk ${candidate.risk}`,
    `Files: ${candidate.files.join(', ')}`,
    `Spec:`,
    candidate.spec,
    ``,
    `Verify every claim against the actual source at HEAD. If the candidate survives but you found the spec's numbers or scope wrong, put the mandatory fixes in "corrections".`,
  ].join('\n')
}

// ---- Phase 1: Map ----------------------------------------------------------
phase('Map')
log(
  `Tournament ${campaignDate}: mapping ${areas.length} rotated area(s) [${areas.map((a) => a.name).join(', ')}] (cursor=${cursor}); ${knownIssues.length} known issues and ${doNotDo.length} ledger entries loaded for dedupe`,
)

const maps = (
  await parallel(
    areas.map((area) => () =>
      agent(mapperPrompt(area), { label: `map:${area.name}`, phase: 'Map', schema: SEAM_SCHEMA }),
    ),
  )
).filter(Boolean)

const totalSeams = maps.reduce((n, m) => n + m.seams.length, 0)
log(`Mapping done: ${totalSeams} seams across ${maps.length}/${areas.length} areas`)

// ---- Phase 2: Propose (barrier justified: every lens reads all maps) -------
phase('Propose')
const mapsJson = JSON.stringify(
  maps.map((m) => ({ area: m.area, seams: m.seams })),
  null,
  1,
)

const lensResults = (
  await parallel(
    LENSES.map((lens) => () =>
      agent(lensPrompt(lens, mapsJson), { label: `lens:${lens.key}`, phase: 'Propose', schema: CANDIDATE_SCHEMA }),
    ),
  )
).filter(Boolean)

const rawCandidates = lensResults.flatMap((r) => r.candidates.map((c) => ({ ...c, lens: r.lens })))
log(`Lenses proposed ${rawCandidates.length} raw candidates`)

// ---- Phase 3: Dedupe (barrier justified: needs the full candidate set) -----
phase('Dedupe')
const dedupe = rawCandidates.length
  ? await agent(
      [
        `Merge and dedupe tech-debt candidates for the TeXRA tournament ${campaignDate}. READ-ONLY; no edits.`,
        ``,
        `1. Merge near-duplicate candidates (same deletion proposed by different lenses) into the single strongest spec.`,
        `2. Drop any candidate that duplicates an EXISTING issue below (report which). Titles will not match verbatim — judge by substance, and check the issue on GitHub or in the repo docs when unsure.`,
        `3. Drop any candidate banned by the DO-NOT-DO ledger below (report which). Ledger entries are adjudicated verdicts; do not relitigate them here.`,
        ``,
        `Existing issues:`,
        knownIssues.length ? knownIssues.map((s) => `- ${s}`).join('\n') : '- (none provided)',
        ``,
        `Do-not-do ledger:`,
        doNotDo.length ? doNotDo.map((s) => `- ${s}`).join('\n') : '- (none provided)',
        ``,
        `Candidates (JSON):`,
        JSON.stringify(rawCandidates, null, 1),
      ].join('\n'),
      { label: 'dedupe', phase: 'Dedupe', schema: DEDUPE_SCHEMA },
    )
  : { kept: [], droppedAsKnown: [], droppedAsDoNotDo: [], merged: [] }

const ranked = [...dedupe.kept].sort((a, b) => b.estLoc - a.estLoc)
const toVerify = ranked.slice(0, MAX_VERIFY)
if (ranked.length > toVerify.length) {
  log(`Capping verification at ${MAX_VERIFY}: dropping ${ranked.length - toVerify.length} lowest-LoC candidates: ${ranked
    .slice(MAX_VERIFY)
    .map((c) => c.title)
    .join(' | ')}`)
}
log(`Dedupe done: ${dedupe.kept.length} kept, ${dedupe.droppedAsKnown.length} already tracked, ${dedupe.droppedAsDoNotDo.length} ledger-banned; verifying ${toVerify.length}`)

// ---- Phase 4: Verify (pipeline: each candidate verifies independently) -----
phase('Verify')
const verified = await pipeline(toVerify, (candidate) =>
  parallel(
    REFUTER_LENSES.map((lens) => () =>
      agent(refuterPrompt(candidate, lens), {
        label: `verify:${lens.key}:${candidate.area}`,
        phase: 'Verify',
        schema: VERDICT_SCHEMA,
      }),
    ),
  ).then((votes) => {
    const cast = votes.filter(Boolean)
    const refutes = cast.filter((v) => v.refuted)
    return {
      ...candidate,
      verdict: cast.length >= 2 && refutes.length === 0 ? 'REAL_NET_GAIN' : refutes.length >= 2 ? 'NET_LOSS' : 'CONTESTED',
      votes: cast,
      corrections: cast.map((v) => v.corrections).filter((s) => s && s.trim()),
    }
  }),
)

const allSurvivors = verified.filter(Boolean).filter((c) => c.verdict === 'REAL_NET_GAIN')
const rejected = verified.filter(Boolean).filter((c) => c.verdict === 'NET_LOSS')
const contested = verified.filter(Boolean).filter((c) => c.verdict === 'CONTESTED')

// Don't overshoot: file only the smallest/lowest-risk MAX_FILE survivors this cycle.
// Smaller, easier-to-review PRs land faster than a wall of simultaneous refactors;
// larger or lower-priority survivors carry over to be re-proposed (post-dedupe) next cycle.
const riskRank = { low: 0, medium: 1, high: 2 }
const bySafetyThenSize = [...allSurvivors].sort(
  (a, b) => riskRank[a.risk] - riskRank[b.risk] || a.estLoc - b.estLoc,
)
const toFile = bySafetyThenSize.slice(0, MAX_FILE)
const carriedForward = bySafetyThenSize.slice(MAX_FILE)
if (carriedForward.length) {
  log(`Filing cap ${MAX_FILE}: carrying ${carriedForward.length} verified survivor(s) forward instead of filing this cycle: ${carriedForward.map((c) => c.title).join(' | ')}`)
}

// NET_LOSS with a confident majority becomes a ledger entry so future sweeps stop re-proposing it.
const newDoNotDo = rejected
  .filter((c) => c.votes.filter((v) => v.refuted && v.confidence !== 'low').length >= 2)
  .map((c) => ({
    entry: `${c.title}: NET_LOSS (tournament ${campaignDate})`,
    reasons: c.votes.filter((v) => v.refuted).map((v) => v.reason),
  }))

log(
  `Verification done: ${allSurvivors.length} REAL_NET_GAIN (${toFile.length} to file, ~-${toFile.reduce((n, c) => n + c.estLoc, 0)} LoC), ${rejected.length} NET_LOSS, ${contested.length} contested (not filed)`,
)

return {
  campaignDate,
  areasThisCycle: areas.map((a) => a.name),
  nextCursor: cursor + rotationSize,
  toFile,
  carriedForward,
  contested,
  rejected,
  newDoNotDo,
  droppedAsKnown: dedupe.droppedAsKnown,
  droppedAsDoNotDo: dedupe.droppedAsDoNotDo,
  merged: dedupe.merged,
  seamCount: totalSeams,
}
