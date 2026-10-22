import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fixture, hasCommand, tempDir } from './helpers.ts';

const execFileP = promisify(execFile);

test('vipsthumbnail decodes HEIC', { skip: !hasCommand('vipsthumbnail') }, async () => {
  const out = join(await tempDir(), 't.jpg');
  await execFileP('vipsthumbnail', [fixture('sample.heic'), '--size', '480x480>', '-o', out + '[Q=80,strip]']);
  assert.ok((await stat(out)).size > 0);
});
test('ffmpeg grabs a poster frame', { skip: !hasCommand('ffmpeg') }, async () => {
  const out = join(await tempDir(), 'p.jpg');
  await execFileP('ffmpeg', ['-v', 'error', '-ss', '0', '-i', fixture('clip.mp4'), '-frames:v', '1', '-y', out]);
  assert.ok((await stat(out)).size > 0);
});
