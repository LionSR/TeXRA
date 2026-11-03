const latex = await import("builtIn:latex");

const schema = {
  type: "object",
  properties: {
    section: { type: "string", description: "Exact title of the section checked" },
    claim: { type: "string", description: "The claim of the section, quoted or paraphrased" },
    supported: { type: "boolean", description: "Whether the draft supports the claim as stated" },
    severity: { type: "string", enum: ["none", "minor", "major"] },
    reasoning: { type: "string" },
    recommendation: { type: "string" }
  },
  required: ["section", "claim", "supported", "severity", "reasoning", "recommendation"],
  additionalProperties: false
};

// 1. Sections of the draft
const outline = await latex.outline("draft.tex");
const titles = outline.sections.map(s => s.title);

// 2. Round 1: first section
const r1 = await self(
  `You are reviewing the LaTeX draft draft.tex in this workspace (do not edit it).
Round 1: review ONLY the section titled "${titles[0]}", i.e. the first section.
Read draft.tex yourself first. Decide what the section claims and whether the draft
supports that claim (does it state hypotheses/definitions correctly and back what it asserts,
or is a needed proof/justification missing?). Judge strictly: a bare assertion with no
justification is NOT supported. Submit the structured verdict.`,
  { schema, label: "review round 1" }
);

// 3. Round 2: section chosen from round 1's verdict
const v1 = r1.structured;
const round2Section = v1 && v1.supported === false && v1.severity !== "none"
  ? titles[1]
  : titles[titles.length - 1];

const r2 = await self(
  `You are reviewing the LaTeX draft draft.tex in this workspace (do not edit it).
Round 1 verdict: section "${v1?.section}" supported=${v1?.supported}, severity=${v1?.severity};
reason: ${v1?.reasoning}
Round 2: review ONLY the section titled "${round2Section}".
Read draft.tex yourself first. Decide whether the draft supports that section's claim as stated
(a claim whose proof is omitted, or that is asserted without justification, is NOT supported).
Submit the structured verdict.`,
  { schema, label: "review round 2" }
);

// 4. Count this run's children that ended completed
const me = await tools.executions({ path: "/executions/current" });
const myId = (typeof me === "string" ? me : "").match(/\b([0-9a-f]{8,})\b/)?.[1];
const q = await tools.executions({
  path: "/executions",
  action: "query",
  sql: "SELECT COUNT(*) AS n FROM runs WHERE parent_id = ? AND status = 'ended' AND outcome = 'completed'",
  params: [myId]
});

return {
  sections: titles,
  round1: v1,
  round2: r2.structured,
  round2Section,
  completedChildren: q.rows[0]?.[0] ?? null,
  debug: { myId, children: q.rows }
};
