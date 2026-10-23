import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanUsername, hiddenNote, locationOf, roleName, trashNote, userCount, userSub } from './settings.ts';

test('the user list: the role, who you are, how many', () => {
  assert.equal(roleName('admin'), 'Administrator');
  assert.equal(roleName('member'), 'Member');
  assert.equal(userSub('admin', true), 'Administrator · You');
  assert.equal(userSub('member', true), 'Member · You');
  assert.equal(userSub('member', false), 'Member');
  assert.equal(userCount(1), '1 user');   // a new gallery has only its administrator
  assert.equal(userCount(4), '4 users');
});

test('cleanUsername: no spaces and lower case, as the design does while a name is typed', () => {
  assert.equal(cleanUsername('Pa Pa'), 'papa');
  assert.equal(cleanUsername('  Mama\t'), 'mama');
  assert.equal(cleanUsername('a.b-c_1'), 'a.b-c_1');
  assert.equal(cleanUsername(''), '');
});

test('the Recycle Bin words: the number comes from the server, and a day or a file is not "1 days"', () => {
  assert.equal(trashNote(30), 'Items are deleted for good after 30 days.');
  assert.equal(trashNote(1), 'Items are deleted for good after 1 day.');
  assert.equal(hiddenNote(12), 'Contains 12 hidden files');
  assert.equal(hiddenNote(1), 'Contains 1 hidden file');
});

test('locationOf: the folder an item was deleted from, which is its original path without its name', () => {
  assert.equal(locationOf({ originalPath: '/media/photos/Family/IMG_1.jpg' }), '/media/photos/Family');
  assert.equal(locationOf({ originalPath: '/media/photos/Дача #2 (2024)' }), '/media/photos');
  assert.equal(locationOf({ originalPath: 'dev-data/media/photos/Family' }), 'dev-data/media/photos');
  assert.equal(locationOf({ originalPath: '/IMG_1.jpg' }), '/');
  assert.equal(locationOf({ originalPath: 'IMG_1.jpg' }), '.');
});
