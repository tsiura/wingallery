import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canBack, canForward, placeAt, popped, pushed } from './nav.ts';

test('a page that has just opened has nowhere to go back or forward to', () => {
  const p = placeAt(null);   // the first entry of the app: nothing is stored in it yet
  assert.deepEqual(p, { idx: 0, max: 0 });
  assert.equal(canBack(p), false); assert.equal(canForward(p), false);
});

test('pushing folders, going back and forward, and pushing again drops what was ahead', () => {
  let p = placeAt(null);
  p = pushed(p); p = pushed(p); p = pushed(p);
  assert.deepEqual(p, { idx: 3, max: 3 });
  assert.equal(canBack(p), true); assert.equal(canForward(p), false);
  p = popped(p, { idx: 1 });                       // back twice (or a jump through the browser's history list)
  assert.deepEqual(p, { idx: 1, max: 3 });
  assert.equal(canBack(p), true); assert.equal(canForward(p), true);
  p = popped(p, { idx: 2 });                       // forward once
  assert.deepEqual(p, { idx: 2, max: 3 });
  p = popped(p, null);                             // all the way back: the entry that carries no state is entry 0
  assert.deepEqual(p, { idx: 0, max: 3 });
  assert.equal(canBack(p), false); assert.equal(canForward(p), true);
  p = pushed(p);                                   // a new folder from here: the old 1..3 are gone for good
  assert.deepEqual(p, { idx: 1, max: 1 });
  assert.equal(canForward(p), false);
});

test('a reload keeps the entry number, and the entries ahead show up when they are visited', () => {
  let p = placeAt({ idx: 4 });                     // history.state survives a reload
  assert.deepEqual(p, { idx: 4, max: 4 });
  p = popped(p, { idx: 3 });                       // back: the entry we reloaded on is ahead now
  assert.equal(canForward(p), true);
  p = popped(placeAt({ idx: 4 }), { idx: 6 });     // forward beyond what this page knew about
  assert.deepEqual(p, { idx: 6, max: 6 });
});

test('whatever is in history.state, the number is a whole number from zero up', () => {
  for (const state of [undefined, 'x', 7, [], {}, { idx: -1 }, { idx: 1.5 }, { idx: '2' }, { idx: NaN }, { idx: Infinity }]) {
    assert.deepEqual(placeAt(state), { idx: 0, max: 0 }, JSON.stringify(state));
  }
});
