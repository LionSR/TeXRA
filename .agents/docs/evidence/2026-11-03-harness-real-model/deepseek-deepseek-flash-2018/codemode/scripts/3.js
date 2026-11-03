const latex = await import("builtIn:latex");

// 1. Sections of the draft
const { sections } = await latex.outline("draft.tex");
const titles = sections.map(s => s.title);

const sectionText = t => (sections.find(s => s.title === t)?.text || "").trim();

const schema = {
  type: "object",
  properties: {
    section: { type: "string", description: "Exact title of the section checked" },
    claim: { type: "string", description: "The specific claim examined" },
    supported: { type: "boolean", description: "Whether the draft supports that claim" },
    evidence: { type: "string", description: "Quoted or paraphrased evidence from the draft" },
    problem: { type: "string", description: "What is unsupported/weak, or 'none'" },
    nextSection: { type: "string", description: "Section title best suited for a follow-up check" }
  },
  required: ["section", "claim", "supported", "evidence", "problem", "nextSection"]
};

const first = titles[0];

const round1 = await self(
  `You are reviewing the LaTeX draft draft.tex in the workspace (single file; you can read its sections with the section-outline tool).\n\n` +
  `Check ONLY the section titled "${first}". Text:\n---\n${sectionText(first)}\n---\n\n` +
  `Pick its central technical claim and judge whether the draft itself supplies support for it (evidence, numbers, derivation, or citation). ` +
  `Be strict: do not credit support that only appears elsewhere unless the section points to it. ` +
  `Set nextSection to the title of the section that most needs checking next because of your finding (if the claim is unsupported, the section that should back it; if it holds, the section whose claim depends on it).`,
  { schema, label: "Round 1 review" }
);

const v1 = round1.structured;

// 2. Round 2 section chosen from round 1's verdict
const norm = s => s.toLowerCase().replace(/[^a-z0-9]/g, "");
let second = titles.find(t => norm(t) === norm(v1.nextSection || ""));
if (!second) second = titles.find(t => norm(t).includes(norm(v1.nextSection || "xx")) || norm(v1.nextSection || "xx").includes(norm(t)));
if (!second || second === first) second = titles.find(t => t !== first) || first;

const round2 = await self(
  `You are reviewing the LaTeX draft draft.tex in the workspace (single file; you can read its sections with the section-outline tool).\n\n` +
  `A prior review of the section "${first}" found: claim = "${v1.claim}"; supported = ${v1.supported}; problem = "${v1.problem}". ` +
  `Because of that, check the section "${second}" next. Text:\n---\n${sectionText(second)}\n---\n\n` +
  `Pick its central claim and judge whether the draft supports it. Where relevant, say whether it resolves the gap flagged in "${first}". ` +
  `Set nextSection to the section a further check should target.`,
  { schema, label: "Round 2 review" }
);

const v2 = round2.structured;

// 3. Count of my child runs that ended completed
const cur = await tools.executions({ path: "/executions/current", action: "view" });
const myId = (String(cur.output).match(/\b[0-9a-f]{8,}\b/) || [])[0];
const cnt = await tools.executions({
  path: "/executions",
  action: "query",
  sql: "SELECT count(*) AS n FROM runs WHERE parent_id = ? AND outcome = 'completed'",
  params: [myId]
});
const completedChildren = Number(cnt.rows[0][0]);

return {
  sectionTitles: titles,
  round1: v1,
  round1ReturnedSection: round1.response?.slice(0, 200),
  round2SectionChosen: second,
  round2: v2,
  myId,
  completedChildren
};
