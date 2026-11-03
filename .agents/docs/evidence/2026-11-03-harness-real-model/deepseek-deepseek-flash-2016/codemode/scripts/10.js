const latex = await import("builtIn:latex");

const outline = await latex.outline("draft.tex");
const titles = outline.sections.map(s => s.title);

const cur = await tools.executions({ path: "/executions/current" });
const myId = cur.output.match(/Run: (\S+)/)[1];

const results = await Promise.all([
  tools.executions({ path: "/executions/099259f8039eea85d817672e/result" }),
  tools.executions({ path: "/executions/29bf8675cdcb1b5413983e2a/result" })
]);
const v = results.map(r => JSON.parse(r.output).output.structured);

const q = await tools.executions({
  path: "/executions",
  action: "query",
  sql: "SELECT COUNT(*) AS n FROM runs WHERE parent_id = ? AND status = 'ended' AND outcome = 'completed'",
  params: [myId]
});

return {
  sections: titles,
  round1: v[0],
  round2: v[1],
  round2ChosenFrom: v[0].supported === false && v[0].severity !== "none" ? titles[1] : titles[titles.length - 1],
  completedChildren: q.rows[0][0],
  parentId: myId
};
