const res = await tools.executions({
  path: "/executions",
  action: "query",
  sql: "SELECT id, parent_id, kind, status, outcome FROM runs WHERE parent_id = ? ORDER BY started_at",
  params: ["2701669016a1"]
});
const countRes = await tools.executions({
  path: "/executions",
  action: "query",
  sql: "SELECT COUNT(*) AS completedChildren FROM runs WHERE parent_id = ? AND status = 'ended' AND outcome = 'completed'",
  params: ["2701669016a1"]
});
return { res, countRes };
