const [ls, mod] = await Promise.all([
  tools.executions({ path: "/executions", action: "view", limit: 5 }),
  (async () => { const m = await import("builtIn:latex"); return Object.keys(m); })()
]);
return { mod, ls: ls.output?.slice(0, 500) };
