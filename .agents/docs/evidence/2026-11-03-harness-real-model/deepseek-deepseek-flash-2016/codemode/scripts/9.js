const a = await tools.executions({ path: "/executions/099259f8039eea85d817672e/result" });
const b = await tools.executions({ path: "/executions/29bf8675cdcb1b5413983e2a/result" });
return { r1: a.output?.slice(0, 2000), r2: b.output?.slice(0, 2000) };
