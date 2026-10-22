import { randomBytes } from 'node:crypto';
import type { Config } from './config.ts';
import type { DB } from './db.ts';
import { log } from './log.ts';
import { findLogin, getMe, setPassword } from './users.ts';

const USAGE = 'Usage: gallery set-password <username>';

// Exit code: 0 when done, 1 for anything it could not do (it prints the usage then). `docker exec <container> gallery <command>` runs this
// in a second process on the same database file, so what it changes shows in the running server at once.
export async function runCli(argv: string[], cfg: Config, db: DB): Promise<number> {
  const [command, name, ...extra] = argv;
  const found = command === 'set-password' && name && extra.length === 0 ? findLogin(db, name) : null;
  if (!found) {
    console.log(USAGE);
    return 1;
  }
  const username = getMe(db, found.id)!.username;           // the account's own spelling, whatever was typed
  const password = randomBytes(12).toString('base64url');   // 96 bits, 16 characters
  await setPassword(db, found.id, password);                // ends every session of that user
  console.log(`New password for ${username}: ${password}`);
  log('password_set', { username, via: 'cli' });
  return 0;
}
