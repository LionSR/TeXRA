export const meta = {
  name: 'debt-audit',
  description:
    'General structural debt audit: scout, map seams, inspect declarative and SSOT opportunities, remove shallow indirection, dedup, and adversarially verify net gain',
  whenToUse:
    'Use for recurring or one-off audits of any TeXRA area. Minimal call: {area, charter}; the engine scouts and decomposes the area itself. Pass seams or lenses only when the audit needs a narrower focus.',
  phases: [
    { title: 'Scout', detail: 'self-decompose the area (skipped when caller passes seams)' },
    { title: 'Map', detail: 'one read-only mapper per seam' },
    { title: 'Ideas', detail: 'open ideation over the merged map' },
    { title: 'Shortlist', detail: 'dedup + rank candidates' },
    { title: 'Verify', detail: 'adversarial net-gain verification per candidate' },
  ],
}

// args: {
//   area: string                       — short name of the area under audit
//   charter?: string                   — free-text description of the territory (directories, why now,
//                                        anything suspicious); the scout decomposes from this when no
//                                        seams are given
//   seams?: [{ key, brief }]           — optional pre-scouted decomposition; omit to let the engine
//                                        decompose itself
//   lenses?: [{ key, brief }]          — optional directed ideation angles; omit for open ideation
//   measured?: string                  — hard numbers the caller grepped up front
//   doNotRedo?: string                 — adjudicated do-not-do items so ideation/verifiers skip them
// }
// Structure is deliberately concentrated at the END of the pipeline: discovery (scout, map, ideas)
// runs with maximum freedom; the adversarial verify gate before filing is where rigor lives, because
// a wrongly-scoped finding costs real implementation cycles downstream.
let A = args
if (typeof A === 'string') A = JSON.parse(A)
A = A || {}
if (!A.area) {
  throw new Error('debt-audit requires args {area, ...}')
}

const GROUND_RULES = `
Repository: the current TeXRA working tree (VS Code extension + Electron desktop + Ink CLI over one shared core). Resolve every path from the repository root; never assume a user name or absolute checkout path.
STRICTLY READ-ONLY: never edit files, never run git-mutating commands (no stash/checkout/commit), never run installs/builds/tests. Greps, wc, git log/show/diff (read-only) are fine. The repo is live; other sessions may commit. Use HEAD as-is.
Include TypeScript sources in every glob and grep (\`--include="*.ts" --include="*.tsx"\`); test-kernel suites are \`*.vitest.ts\` and are covered by plain \`*.ts\` globs.
Cite evidence as file:line. Count with grep -c / wc -l rather than estimating. Your final structured output is data for a downstream program, not prose for a human.`

const PHILOSOPHY = `
Maintainer's standing design criteria (judge everything against these):
1. FEWER ELEMENTS: element = any named construct that must be managed (file, export, class, interface, registry, shim, wrapper). Element count is the metric; LoC is the symptom.
2. NO DUAL SYSTEMS as a resting state (two subsystems doing the same job = top-priority debt).
3. DEEP MODULES, CLEAN INTERFACES (Ousterhout): one owner with real logic inside, minimal surface. Shallow-module proliferation (micro-files, pass-through wrappers, per-kind type pairs, single-caller extractions, one Deps interface per class) is the failure mode.
4. Error discipline: catches only at named boundaries; no fallback chains; no resolveX() re-derivers.
5. HARD-WON LESSON (verified on shipped PRs): converging two hosts behind a typed-port abstraction is net-POSITIVE LoC whenever the duplicated surface is smaller than the seam replacing it. A real win must DELETE components; adding ports/adapters/facades to unify is usually a loss. Renames and relocations are NOT deletions; every claimed deletion must name the symbol that ceases to exist.
${A.doNotRedo ? '\nADJUDICATED DO-NOT-REDO (skip these; they were verified NET_LOSS or won\'t-do):\n' + A.doNotRedo : ''}`

const MEASURED = A.measured ? '\nNumbers measured by the caller at HEAD:\n' + A.measured : ''

const MAP_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'seamSummary',
    'components',
    'dualSystems',
    'declarativeOpportunities',
    'singleSourceConflicts',
    'passThroughs',
    'candidates',
  ],
  properties: {
    seamSummary: {
      type: 'string',
      description:
        '5-10 sentence honest assessment: what exists, how coupled, how much genuinely earns its keep',
    },
    components: {
      type: 'array',
      maxItems: 30,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'path', 'role', 'verdict'],
        properties: {
          name: { type: 'string' },
          path: { type: 'string' },
          loc: { type: 'number' },
          role: { type: 'string', description: 'what it does + who injects/consumes it' },
          verdict: { type: 'string', enum: ['EARNS_KEEP', 'SHALLOW', 'PASS_THROUGH', 'DUAL', 'DEAD'] },
        },
      },
    },
    dualSystems: {
      type: 'array',
      maxItems: 10,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['what', 'sideA', 'sideB', 'evidence'],
        properties: {
          what: { type: 'string' },
          sideA: { type: 'string' },
          sideB: { type: 'string' },
          evidence: { type: 'string' },
        },
      },
    },
    declarativeOpportunities: {
      type: 'array',
      maxItems: 12,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['location', 'currentShape', 'proposedShape', 'safetyEvidence'],
        properties: {
          location: { type: 'string', description: 'file:line and symbol' },
          currentShape: {
            type: 'string',
            description:
              'switch/if ladder, repeated blocks, parallel registration, or hardcoded sequence',
          },
          proposedShape: {
            type: 'string',
            description: 'the lookup table, schema-derived type, or iterable data structure',
          },
          safetyEvidence: {
            type: 'string',
            description:
              'tests and behavior argument covering ordering, defaults, short-circuiting, and exhaustiveness',
          },
        },
      },
    },
    singleSourceConflicts: {
      type: 'array',
      maxItems: 12,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['knowledge', 'locations', 'canonicalOwner', 'semanticCaveat'],
        properties: {
          knowledge: {
            type: 'string',
            description: 'the duplicated constant, type, schema, registry, or derivation',
          },
          locations: {
            type: 'array',
            items: { type: 'string' },
            description: 'every repo-wide occurrence, cited as file:line',
          },
          canonicalOwner: {
            type: 'string',
            description: 'where the knowledge should live and how consumers should reference it',
          },
          semanticCaveat: {
            type: 'string',
            description:
              'why the occurrences are truly identical, or what prevents safe consolidation',
          },
        },
      },
    },
    passThroughs: {
      type: 'array',
      maxItems: 20,
      items: {
        type: 'string',
        description:
          'symbol + file:line, forwarded target, every caller, and whether an interface, port, or test seam makes the indirection load-bearing',
      },
    },
    candidates: {
      type: 'array',
      maxItems: 12,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'deletes', 'replacedBy', 'netLoC', 'elementDelta', 'risk', 'evidence'],
        properties: {
          title: { type: 'string' },
          deletes: { type: 'array', items: { type: 'string' }, description: 'named symbols/files that cease to exist' },
          replacedBy: { type: 'string', description: 'what (if anything) is added instead; be honest' },
          netLoC: { type: 'number', description: 'negative = deletion; count seam cost honestly' },
          elementDelta: { type: 'number', description: 'named-construct count change, negative = fewer' },
          risk: { type: 'string' },
          evidence: { type: 'string' },
        },
      },
    },
    notes: { type: 'string' },
  },
}

let seams = Array.isArray(A.seams) && A.seams.length > 0 ? A.seams : null
if (!seams) {
  phase('Scout')
  const SCOUT_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['seams'],
    properties: {
      seams: {
        type: 'array',
        minItems: 3,
        maxItems: 12,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['key', 'brief'],
          properties: {
            key: { type: 'string', description: 'short kebab-case name' },
            brief: {
              type: 'string',
              description: 'directories/files, the questions worth asking, suspects with any counts you measured',
            },
          },
        },
      },
      measured: { type: 'string', description: 'hard numbers you grepped while scouting' },
    },
  }
  const scout = await agent(
    `Scout the "${A.area}" area of the TeXRA repo for a tech-debt audit and decompose it into parallel-mappable seams.
${GROUND_RULES}
${PHILOSOPHY}
${MEASURED}
${A.charter ? '\nCALLER CHARTER (starting point, not a fence):\n' + A.charter : ''}

Explore however you judge best — directory sizes, import graphs, suspect-pattern greps, git history. Decompose into however many seams the territory actually warrants (disjoint enough that parallel mappers will not duplicate work), and put your measured numbers in the briefs so mappers start from facts.`,
    { label: 'scout', phase: 'Scout', schema: SCOUT_SCHEMA, effort: 'xhigh' },
  )
  if (!scout) throw new Error('scout agent died; pass seams explicitly to skip scouting')
  seams = scout.seams
  if (scout.measured) A.measured = (A.measured ? A.measured + '\n' : '') + scout.measured
  log('scout decomposed "' + A.area + '" into ' + seams.length + ' seams: ' + seams.map((s) => s.key).join(', '))
}

function mapPrompt(s) {
  return `You are one of ${seams.length} parallel seam mappers in a tech-debt audit of the "${A.area}" area.
${GROUND_RULES}
${PHILOSOPHY}
${MEASURED}

YOUR SEAM: ${s.key}
${s.brief}

The brief is a starting point, not a fence: follow the debt where it actually leads, and report load-bearing findings outside the brief rather than dropping them. Read the real code, not just names; grep for consumers before calling anything dead or single-caller.

Also inspect the seam for:
- DECLARATIVE opportunities: value-mapping switch/if ladders, repeated near-identical blocks, hardcoded ordered sequences, and parallel registrations that can become one typed data table. Reject conversions that obscure distinct side effects, weaken discriminated-union exhaustiveness, or change evaluation order, short-circuiting, defaults, or fallthrough.
- SINGLE SOURCE OF TRUTH conflicts: duplicated constants, unions, schemas versus hand-written interfaces, registries, magic values, and derivation logic. Search the whole repo for every occurrence and distinguish genuinely shared knowledge from concepts that merely look similar.
- PASS-THROUGHS: methods, functions, one-call factories, and re-export facades that only forward. Count every caller and recommend keeping any interface contract, host port, test seam, or semantic boundary that earns the indirection.

If the seam is already clean, say so plainly — a false debt claim poisons downstream synthesis, and "healthy" is a valuable verdict. For candidates, only propose deletions where named symbols cease to exist, and estimate netLoC including the cost of whatever replaces them.`
}

phase('Map')
const maps = []
let mc = 0
async function mapWorker() {
  while (mc < seams.length) {
    const s = seams[mc++]
    const r = await agent(mapPrompt(s), { label: 'map:' + s.key, phase: 'Map', schema: MAP_SCHEMA, effort: 'high' })
    if (r) {
      maps.push({ seam: s.key, ...r })
      log('mapped ' + s.key + ' (' + maps.length + '/' + seams.length + ')')
    } else {
      log('mapper DIED: ' + s.key)
    }
  }
}
await parallel(Array.from({ length: 5 }, () => () => mapWorker()))

const IDEAS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ideas'],
  properties: {
    ideas: {
      type: 'array',
      maxItems: 8,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'thesis', 'deletes', 'adds', 'netLoC', 'elementDelta', 'risk', 'sequencing', 'evidence'],
        properties: {
          title: { type: 'string' },
          thesis: {
            type: 'string',
            description: '3-8 sentences: the idea, why the system is simpler after, why this is a deletion not a relocation',
          },
          deletes: { type: 'array', items: { type: 'string' } },
          adds: { type: 'array', items: { type: 'string' } },
          netLoC: { type: 'number' },
          elementDelta: { type: 'number' },
          risk: { type: 'string', description: 'blast radius + the single scariest failure mode' },
          sequencing: { type: 'string', description: 'shippable steps; no dual-system resting state' },
          evidence: { type: 'string', description: 'which map findings support this, with file paths' },
        },
      },
    },
  },
}

const GENERAL_LENSES = [
  {
    key: 'ownership-and-dual-systems',
    brief:
      'Find competing owners, parallel implementations, compatibility arms, lifecycle splits, and components whose responsibilities belong in a deeper existing module. Prefer a change that deletes one system over a new facade that coordinates both.',
  },
  {
    key: 'declarative-and-ssot',
    brief:
      'Find behavior that is really data: value-mapping branches, repeated registrations, duplicated constants or unions, schema/interface drift, and parallel structures encoding the same domain knowledge. Verify every repo-wide occurrence. Reject table rewrites when branches have distinct effects, ordering, narrowing, or short-circuit semantics.',
  },
  {
    key: 'pass-through-elimination',
    brief:
      'Find methods, functions, one-call factories, wrappers, and re-export facades that only forward. Count every caller and name the exact target. Keep deliberate interfaces, host ports, PocketFlow hooks, test seams, and semantic boundaries; collapse only indirection that adds no contract or behavior.',
  },
  {
    key: 'open-structural-simplification',
    brief:
      'Look beyond the named smells for the deepest evidence-backed simplification the other lenses may miss. Prefer fewer concepts and clearer ownership, and reject renames or relocations presented as deletions.',
  },
]

// Callers may replace the general lenses for a deliberately narrow audit.
const IDEATORS = Array.isArray(A.lenses) && A.lenses.length > 0
  ? A.lenses
  : GENERAL_LENSES

phase('Ideas')
const mapDigest = JSON.stringify(maps)
const ideaResults = await parallel(
  IDEATORS.map((l) => () =>
    agent(
      `You are an architect generating DEEP simplification ideas for the "${A.area}" area of the TeXRA repo. Not nitpicks; structural ideas that remove whole components.
${GROUND_RULES}
${PHILOSOPHY}
${MEASURED}

${l.brief}

The seam mappers' full structured findings (JSON):
${mapDigest}

Ground every idea in map evidence (verify surprising claims yourself with a grep before relying on them). Every deletion must name symbols. Count netLoC honestly including additions. Adding ports/facades/adapters as the primary move is almost never the answer here.`,
      { label: 'ideas:' + l.key, phase: 'Ideas', schema: IDEAS_SCHEMA, effort: 'xhigh' },
    ).then((r) => (r ? { lens: l.key, ideas: r.ideas } : null)),
  ),
)

const allIdeas = ideaResults.filter(Boolean).flatMap((r) => r.ideas.map((i) => ({ ...i, lens: r.lens })))
log('collected ' + allIdeas.length + ' raw ideas across ' + ideaResults.filter(Boolean).length + ' ideation agents')

const SHORTLIST_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['shortlist'],
  properties: {
    shortlist: {
      type: 'array',
      maxItems: 15,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'mergedFrom', 'thesis', 'deletes', 'adds', 'netLoC', 'elementDelta', 'risk', 'verifyQuestions'],
        properties: {
          title: { type: 'string' },
          mergedFrom: { type: 'array', items: { type: 'string' } },
          thesis: { type: 'string' },
          deletes: { type: 'array', items: { type: 'string' } },
          adds: { type: 'array', items: { type: 'string' } },
          netLoC: { type: 'number' },
          elementDelta: { type: 'number' },
          risk: { type: 'string' },
          verifyQuestions: {
            type: 'array',
            maxItems: 5,
            items: { type: 'string' },
            description: 'the concrete grep-checkable questions whose answers decide if the net gain is real',
          },
        },
      },
    },
  },
}

phase('Shortlist')
const short = await agent(
  `Dedup and rank these simplification ideas for the "${A.area}" area of the TeXRA repo. Merge overlapping ideas (same deletion target from different lenses) into one stronger candidate, keep the honest (usually more pessimistic) netLoC, and rank by (element reduction x confidence) / risk. Drop relocations dressed as deletions, and drop anything contradicting: ${PHILOSOPHY}
Raw ideas (JSON): ${JSON.stringify(allIdeas)}
Return at most 12. For each, write verifyQuestions: the specific countable facts a skeptic should check in the repo to confirm or kill the idea.`,
  { label: 'shortlist', phase: 'Shortlist', schema: SHORTLIST_SCHEMA, effort: 'xhigh' },
)
if (!short) {
  return { area: A.area, maps, allIdeas, error: 'shortlist agent died' }
}

const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'confidence', 'netLoC', 'elementDelta', 'keyEvidence', 'corrections'],
  properties: {
    verdict: { type: 'string', enum: ['REAL_NET_GAIN', 'WASH', 'NET_LOSS', 'ALREADY_DONE', 'BLOCKED'] },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    netLoC: { type: 'number', description: 'your own corrected estimate' },
    elementDelta: { type: 'number' },
    keyEvidence: { type: 'string', description: 'the grep/wc results that decided it, with file:line' },
    corrections: {
      type: 'string',
      description: 'what the idea got wrong or must change to survive; scope cuts that flip it to REAL',
    },
  },
}

phase('Verify')
const verdicts = []
let vc = 0
async function verifyWorker() {
  while (vc < short.shortlist.length) {
    const i = vc++
    const cand = short.shortlist[i]
    const v = await agent(
      `Adversarially verify this proposed simplification of the TeXRA repo ("${A.area}" area). Your default stance: REFUTE it. It survives only if repo evidence says the net gain is real.
${GROUND_RULES}
${PHILOSOPHY}

CANDIDATE: ${JSON.stringify(cand)}

Do the work: answer each verifyQuestion with actual greps/wc. Check (a) every 'deletes' symbol exists and count its real consumers, (b) the replacement cost, (c) whether it already shipped (git log --oneline -80, grep the symbols; this repo merges dozens of PRs a day, so ALREADY_DONE is common), (d) risk realism: persisted-format breaks (transcript/resume), headless parity (texra run/--print byte-identical), the host @agent deep-import ratchet test, recent deliberate design decisions the deletion would reverse (git log the target files and read the PRs). Then give the corrected netLoC/elementDelta and verdict. A scope cut that makes it REAL belongs in corrections.`,
      { label: 'verify:' + cand.title.slice(0, 40), phase: 'Verify', schema: VERDICT_SCHEMA, effort: 'high' },
    )
    verdicts.push({ title: cand.title, candidate: cand, verdict: v })
    log('verified ' + verdicts.length + '/' + short.shortlist.length + ': ' + cand.title.slice(0, 50) + ' -> ' + (v ? v.verdict : 'AGENT_DIED'))
  }
}
await parallel(Array.from({ length: 5 }, () => () => verifyWorker()))

const seamSummaries = maps.map((m) => ({
  seam: m.seam,
  seamSummary: m.seamSummary,
  dualSystems: m.dualSystems,
  declarativeOpportunities: m.declarativeOpportunities,
  singleSourceConflicts: m.singleSourceConflicts,
  passThroughs: m.passThroughs,
}))
return { area: A.area, seamSummaries, shortlist: short.shortlist, verdicts }
