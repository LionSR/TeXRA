const { outline } = await import("builtIn:latex");
const { sections } = await outline("draft.tex");

const schema = {
  type: "object",
  properties: {
    section: { type: "string" },
    claim: { type: "string" },
    supported: { type: "boolean" },
    reason: { type: "string" }
  },
  required: ["section", "claim", "supported", "reason"],
  additionalProperties: false
};

const r1 = await self(
  `Review round 1 of draft.tex. Check ONLY the first section: ${JSON.stringify(sections[0])}. Return section, claim, supported, reason.`,
  { fork: false, schema, label: "Round 1" }
);
const r2 = await self(
  `Review round 2 of draft.tex. Round 1 verdict on "Setup": supported=${r1.structured.supported} (${r1.structured.reason}). Accordingly check the section that carries the first real mathematical assertion: ${JSON.stringify(sections[1])}. Return section, claim, supported, reason.`,
  { fork: false, schema, label: "Round 2" }
);

const count = await tools.executions({
  path: "/executions",
  action: "query",
  sql: "SELECT COUNT(*) AS n FROM runs WHERE parent_id = ? AND status = 'ended' AND outcome = 'completed'",
  params: ["2701669016a1"]
});

return {
  sectionTitles: sections.map(s => s.title),
  verdicts: [r1.structured, r2.structured],
  completedChildren: count.rows[0][0]
};
