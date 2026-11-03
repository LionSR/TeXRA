const t = await self("Reply with the single word: ok", { fork: false, label: "probe" });
return { probe: JSON.stringify(t).slice(0, 400) };
