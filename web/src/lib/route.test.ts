import assert from 'node:assert/strict';
import { test } from 'node:test';
import { browseHref, crumbsOf, joinV, nameOf, parentOf, ROOT_NAME, vpathFromLocation } from './route.ts';

test('route helpers', () => {
  assert.equal(vpathFromLocation('/browse'), '/'); assert.equal(vpathFromLocation('/browse/'), '/');
  assert.equal(vpathFromLocation('/browse/Family%20photos/%D0%94%D0%B0%D1%87%D0%B0%20%232'), '/Family photos/Дача #2');
  assert.equal(browseHref('/Family photos/IMG 50%'), '/browse/Family%20photos/IMG%2050%25');
  assert.equal(parentOf('/a/b'), '/a'); assert.equal(parentOf('/a'), '/'); assert.equal(parentOf('/'), null);
  assert.equal(nameOf('/a/b'), 'b'); assert.equal(joinV('/', 'a'), '/a'); assert.equal(joinV('/a', 'b'), '/a/b');
});

test('breadcrumbs: the root, then each folder with the path that opens it', () => {
  assert.equal(ROOT_NAME, 'Home Gallery');
  assert.deepEqual(crumbsOf('/'), [{ name: 'Home Gallery', vpath: '/' }]);
  assert.deepEqual(crumbsOf('/Family photos/Дача #2'), [
    { name: 'Home Gallery', vpath: '/' }, { name: 'Family photos', vpath: '/Family photos' }, { name: 'Дача #2', vpath: '/Family photos/Дача #2' },
  ]);
});

test('a hand-typed address never breaks the app', () => {
  assert.equal(vpathFromLocation('/browse/100%'), '/100%');    // a bad %-escape stays as typed; the server then says the folder isn't there
  assert.equal(vpathFromLocation('/browse//a///b/'), '/a/b');  // empty segments are dropped
  assert.equal(vpathFromLocation('/setup'), '/');              // not under /browse
  assert.equal(vpathFromLocation('/browser/a'), '/');
  assert.equal(browseHref('/'), '/browse/');
});
