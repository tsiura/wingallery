import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createApp } from './app.ts';
import { runCli } from './cli.ts';
import { loadConfig } from './config.ts';
import { openDb } from './db.ts';
import { log } from './log.ts';
import { purgeExpired } from './trash.ts';

const cfg = loadConfig();
mkdirSync(cfg.dataDir, { recursive: true });
const db = openDb(join(cfg.dataDir, 'gallery.db'));

// With arguments this is a one-off command (`gallery set-password <user>`), not the server.
if (process.argv.length > 2) process.exit(await runCli(process.argv.slice(2), cfg, db));

const app = createApp(cfg, db);

app.server.listen(cfg.port, () => log('listening', { port: cfg.port }));
// The only place the link is shown (a plain line, not an audit event, so it appears once in the container log).
if (app.setupToken) console.log(`First run: open https://<your-domain>/setup?token=${app.setupToken} to create the admin account`);
// What has been in the Recycle Bin longer than TRASH_DAYS goes when the server starts and then once a day. A failure is logged, and the next run tries again.
const purgeBin = () => purgeExpired(cfg, db, cfg.trashDays).catch((err) =>
  log('error', { message: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined }));
void purgeBin();
setInterval(() => void purgeBin(), 24 * 60 * 60 * 1000).unref();
for (const signal of ['SIGTERM', 'SIGINT'] as const)
  process.on(signal, () => void app.close().then(() => process.exit(0)));
