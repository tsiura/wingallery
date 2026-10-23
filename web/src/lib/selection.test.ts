import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyClick, arrowTo, NO_SELECTION, pruneSel, selectAll } from './selection.ts';

const PLAIN = { ctrl: false, shift: false }, CTRL = { ctrl: true, shift: false }, SHIFT = { ctrl: false, shift: true };
const order = ['a', 'b', 'c', 'd'];

test('click, ctrl, shift', () => {
  let s = applyClick({ selected: [], anchor: null }, order, 'b', { ctrl: false, shift: false });
  assert.deepEqual(s, { selected: ['b'], anchor: 'b' });
  s = applyClick(s, order, 'd', { ctrl: true, shift: false }); assert.deepEqual(s.selected, ['b', 'd']);
  s = applyClick(s, order, 'b', { ctrl: true, shift: false }); assert.deepEqual(s.selected, ['d']);
  s = applyClick({ selected: ['b'], anchor: 'b' }, order, 'd', { ctrl: false, shift: true }); assert.deepEqual(s, { selected: ['b', 'c', 'd'], anchor: 'b' });
  assert.deepEqual(selectAll(order).selected, order);
});

test('a plain click leaves only that item; ctrl moves the anchor to the item it toggled', () => {
  let s = applyClick({ selected: ['a', 'b', 'c'], anchor: 'a' }, order, 'c', PLAIN);
  assert.deepEqual(s, { selected: ['c'], anchor: 'c' });
  s = applyClick(s, order, 'a', CTRL);
  assert.deepEqual(s, { selected: ['a', 'c'], anchor: 'a' });      // in list order, not in the order they were clicked
});

test('shift selects from the anchor to the click, either way along the list, and keeps the anchor', () => {
  let s = applyClick({ selected: ['c'], anchor: 'c' }, order, 'a', SHIFT);
  assert.deepEqual(s, { selected: ['a', 'b', 'c'], anchor: 'c' });
  s = applyClick(s, order, 'd', SHIFT);                            // the range is measured from the anchor again, not added to
  assert.deepEqual(s, { selected: ['c', 'd'], anchor: 'c' });
});

test('ctrl+shift adds the range to what is selected', () => {
  const s = applyClick({ selected: ['a', 'c'], anchor: 'c' }, order, 'd', { ctrl: true, shift: true });
  assert.deepEqual(s, { selected: ['a', 'c', 'd'], anchor: 'c' });
});

test('shift with no anchor, or an anchor that is no longer in the list, is a plain click', () => {
  assert.deepEqual(applyClick(NO_SELECTION, order, 'c', SHIFT), { selected: ['c'], anchor: 'c' });
  assert.deepEqual(applyClick({ selected: ['x'], anchor: 'x' }, order, 'b', SHIFT), { selected: ['b'], anchor: 'b' });
});

test('select all takes the whole list, anchored on its first item; of an empty list it takes nothing', () => {
  assert.deepEqual(selectAll(order), { selected: order, anchor: 'a' });
  assert.notEqual(selectAll(order).selected, order);               // a copy: the list itself is never the selection
  assert.deepEqual(selectAll([]), { selected: [], anchor: null });
});

test('pruneSel drops what is no longer in the list (a search, a reload) and gives back the same object when nothing goes', () => {
  const s = { selected: ['a', 'x', 'c'], anchor: 'x' };
  assert.deepEqual(pruneSel(s, order), { selected: ['a', 'c'], anchor: 'x' });
  const whole = { selected: ['a', 'b'], anchor: 'a' };
  assert.equal(pruneSel(whole, order), whole);
  assert.equal(pruneSel(NO_SELECTION, order), NO_SELECTION);
});

test('arrow keys go one along a row, a row down or up, and never off the list', () => {
  assert.equal(arrowTo('ArrowRight', 0, 10, 4), 1);
  assert.equal(arrowTo('ArrowRight', 3, 10, 4), 4);               // the end of a row goes on to the next
  assert.equal(arrowTo('ArrowLeft', 4, 10, 4), 3);
  assert.equal(arrowTo('ArrowDown', 1, 10, 4), 5);
  assert.equal(arrowTo('ArrowUp', 5, 10, 4), 1);
  assert.equal(arrowTo('ArrowLeft', 0, 10, 4), 0);                // the first and the last stay
  assert.equal(arrowTo('ArrowRight', 9, 10, 4), 9);
  assert.equal(arrowTo('ArrowUp', 2, 10, 4), 2);                  // nothing above the first row
  assert.equal(arrowTo('ArrowDown', 7, 10, 4), 9);               // the last row is short: down from the row above it ends on its last item
  assert.equal(arrowTo('ArrowDown', 9, 10, 4), 9);
});

test('a list is a grid of one column; with no item focused the first one is where the arrows start; other keys are not arrows', () => {
  assert.equal(arrowTo('ArrowDown', 3, 10, 1), 4);
  assert.equal(arrowTo('ArrowRight', 3, 10, 1), 4);
  assert.equal(arrowTo('ArrowUp', 3, 10, 1), 2);
  assert.equal(arrowTo('ArrowDown', 9, 10, 1), 9);
  assert.equal(arrowTo('ArrowDown', -1, 10, 4), 0);
  assert.equal(arrowTo('a', 3, 10, 4), null);
  assert.equal(arrowTo('Enter', 3, 10, 4), null);
  assert.equal(arrowTo('ArrowDown', 0, 0, 4), null);
});
