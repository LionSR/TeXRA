const fs = await import('builtIn:fs').catch(() => null);
return fs ? 'fs ok' : 'no fs';

