const rows = await tools.executions({
  path: "/executions",
  action: "query",
  sql: "SELECT id, status, outcome FROM runs WHERE parent_id = ? ORDER BY started_at",
  params: ["2701669016a1"]
});
return rows.rows;
