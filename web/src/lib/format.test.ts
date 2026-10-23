import assert from 'node:assert/strict';
import { test } from 'node:test';
import { avatarColor, fmtDate, fmtDur, fmtEpoch, fmtSize, initials } from './format.ts';

test('formatting matches the design', () => {
  assert.equal(fmtDate('2026-03-14T09:00:00'), 'Mar 14, 2026  09:00');
  assert.equal(fmtSize(1.8e6), '1.8 MB'); assert.equal(fmtSize(2.5e9), '2.5 GB'); assert.equal(fmtSize(512_400), '512 KB');
  assert.equal(fmtDur(98), '1:38'); assert.equal(fmtDur(9), '0:09');
  assert.equal(initials('Alex Morgan'), 'AM'); assert.equal(initials('papa'), 'P'); assert.equal(initials(''), '?');
  assert.equal(avatarColor(7), '#8a5a00');
});

test('instants and fractions', () => {
  assert.equal(fmtEpoch(new Date(2026, 2, 14, 9, 0).getTime()), 'Mar 14, 2026  09:00');   // the browser's own wall clock, whatever its zone
  assert.equal(fmtDur(98.4), '1:38');   // ffprobe gives fractions; the design's m:ss never sees them
  assert.equal(fmtDate('2026-12-01T00:05:09'), 'Dec 1, 2026  00:05');
  assert.equal(initials('Иван Петров Сидоров'), 'ИП');
});
