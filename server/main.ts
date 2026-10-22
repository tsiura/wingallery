import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createApp } from './app.ts';
import { loadConfig } from './config.ts';
import { openDb } from './db.ts';
import { log } from './log.ts';

const cfg = loadConfig();
mkdirSync(cfg.dataDir, { recursive: true });
const db = openDb(join(cfg.dataDir, 'gallery.db'));
const app = createApp(cfg, db);

app.server.listen(cfg.port, () => log('listening', { port: cfg.port }));
for (const signal of ['SIGTERM', 'SIGINT'] as const)
  process.on(signal, () => void app.close().then(() => process.exit(0)));
