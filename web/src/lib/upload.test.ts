import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CHUNK, createUploadQueue, filesOf, uploadFile, uploadSummary } from './upload.ts';
import type { UploadProgress } from './upload.ts';

test('uploadFile sends 8 MiB chunks in order', async () => {
  const calls: string[] = [];
  const fake = (async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method} ${url}`);
    if (url === '/api/upload/start') return Response.json({ id: 'U' });
    const off = Number(new URL(url, 'http://x').searchParams.get('offset')), len = (init!.body as Blob).size;
    return Response.json(off + len === 2 * CHUNK + 5 ? { done: true, name: 'v (1).mp4' } : { received: off + len });
  }) as typeof fetch;
  const sent: number[] = [];
  const name = await uploadFile(new Blob([new Uint8Array(2 * CHUNK + 5)]) as any as File, '/Fam', (s) => sent.push(s), new AbortController().signal, fake);
  assert.equal(name, 'v (1).mp4');
  assert.deepEqual(calls.slice(1), [`PUT /api/upload/U?offset=0`, `PUT /api/upload/U?offset=${CHUNK}`, `PUT /api/upload/U?offset=${2 * CHUNK}`]);
  assert.deepEqual(sent, [CHUNK, 2 * CHUNK, 2 * CHUNK + 5]);
});

test('uploadFile surfaces server errors and cancels on abort', async () => {
  const err = (async () => Response.json({ error: 'Only photos and videos can be uploaded' }, { status: 415 })) as typeof fetch;
  await assert.rejects(uploadFile(new Blob(['x']) as any, '/Fam', () => {}, new AbortController().signal, err), { message: 'Only photos and videos can be uploaded' });
  const ac = new AbortController(); const seen: string[] = [];
  const slow = (async (url: string, init?: RequestInit) => { seen.push(`${init?.method} ${url}`); if (url === '/api/upload/start') { ac.abort(); return Response.json({ id: 'Z' }); } return Response.json({ ok: true }); }) as typeof fetch;
  await assert.rejects(uploadFile(new Blob(['x']) as any, '/Fam', () => {}, ac.signal, slow), { name: 'AbortError' });
  assert.ok(seen.includes('DELETE /api/upload/Z'));
});

test('the start request names the folder, the file and its size', async () => {
  let start: { url: string; init?: RequestInit } | undefined;
  const fake = (async (url: string, init?: RequestInit) => {
    if (url === '/api/upload/start') { start = { url, init }; return Response.json({ id: 'S' }); }
    return Response.json({ done: true, name: 'IMG 1.jpg' });
  }) as typeof fetch;
  const file = Object.assign(new Blob(['abc']), { name: 'IMG 1.jpg' });
  assert.equal(await uploadFile(file as any as File, '/Дача #2', () => {}, new AbortController().signal, fake), 'IMG 1.jpg');
  assert.equal(start?.init?.method, 'POST');
  assert.deepEqual(start?.init?.headers, { 'content-type': 'application/json' });
  assert.deepEqual(JSON.parse(start?.init?.body as string), { dir: '/Дача #2', name: 'IMG 1.jpg', size: 3 });
});

test('a chunk goes up as binary, and the server answering "received" and not "done" at the last byte is a failure, not a hang', async () => {
  let put: RequestInit | undefined;
  const fake = (async (url: string, init?: RequestInit) => {
    if (url === '/api/upload/start') return Response.json({ id: 'P' });
    if (init?.method === 'DELETE') return Response.json({ ok: true });
    put = init;
    return Response.json({ received: 3 });
  }) as typeof fetch;
  await assert.rejects(uploadFile(new Blob(['abc']) as any, '/Fam', () => {}, new AbortController().signal, fake), /finish/i);
  assert.deepEqual(put?.headers, { 'content-type': 'application/octet-stream' });
  assert.equal(put?.method, 'PUT');
});

test('R1: a chunk that fails, with a status or with none at all (a reset), fails the file: one request, a clear message, no retry, the temp file dropped', async () => {
  for (const [what, fail, message] of [
    ['a reset', () => { throw new TypeError('fetch failed'); }, 'Upload interrupted: the connection was lost'],
    ['a 409', () => Response.json({ error: 'Upload out of sync' }, { status: 409 }), 'Upload out of sync'],
    ['a 404', () => Response.json({ error: 'Not found' }, { status: 404 }), 'Not found'],
    ['an answer that is not JSON', () => new Response('<h1>Bad gateway</h1>', { status: 502 }), 'Something went wrong'],
  ] as const) {
    const calls: string[] = [];
    const sent: number[] = [];
    const fake = (async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method} ${url}`);
      if (url === '/api/upload/start') return Response.json({ id: 'R' });
      if (init?.method === 'DELETE') return Response.json({ ok: true });
      return fail();
    }) as typeof fetch;
    await assert.rejects(uploadFile(new Blob([new Uint8Array(CHUNK + 1)]) as any, '/Fam', (s) => sent.push(s), new AbortController().signal, fake), { message }, what);
    assert.deepEqual(calls, ['POST /api/upload/start', 'PUT /api/upload/R?offset=0', 'DELETE /api/upload/R'], what);   // the second chunk is never tried
    assert.deepEqual(sent, [], what);
  }
});

test('a failure that is not a cancel is not an AbortError, and the cleanup that fails too changes nothing', async () => {
  const fake = (async (url: string, init?: RequestInit) => {
    if (url === '/api/upload/start') return Response.json({ id: 'Q' });
    if (init?.method === 'DELETE') throw new TypeError('offline');
    throw new TypeError('offline');
  }) as typeof fetch;
  await assert.rejects(uploadFile(new Blob(['abc']) as any, '/Fam', () => {}, new AbortController().signal, fake), (e: Error) => e.name === 'Error' && /interrupted/.test(e.message));
});

test('aborting a chunk in flight stops it and drops the upload; an aborted start has no upload to drop', async () => {
  const ac = new AbortController();
  const seen: string[] = [];
  const fake = (async (url: string, init?: RequestInit) => {
    seen.push(`${init?.method} ${url}`);
    if (url === '/api/upload/start') return Response.json({ id: 'A' });
    if (init?.method === 'DELETE') return Response.json({ ok: true });
    return new Promise<Response>((_, reject) => {
      init!.signal!.addEventListener('abort', () => reject(new DOMException('This operation was aborted', 'AbortError')));
      queueMicrotask(() => ac.abort());
    });
  }) as typeof fetch;
  await assert.rejects(uploadFile(new Blob(['abc']) as any, '/Fam', () => {}, ac.signal, fake), { name: 'AbortError' });
  assert.deepEqual(seen, ['POST /api/upload/start', 'PUT /api/upload/A?offset=0', 'DELETE /api/upload/A']);

  const early = new AbortController();
  early.abort();
  const none: string[] = [];
  const refuse = (async (url: string, init?: RequestInit) => { none.push(`${init?.method} ${url}`); throw new DOMException('This operation was aborted', 'AbortError'); }) as typeof fetch;
  await assert.rejects(uploadFile(new Blob(['abc']) as any, '/Fam', () => {}, early.signal, refuse), { name: 'AbortError' });
  assert.ok(!none.some((call) => call.startsWith('DELETE')));
});

// A server that answers every start at once and every chunk after a pause, and counts how many uploads are open at the same time.
function pausingServer(pause = 5) {
  const log: string[] = [];
  let open = 0, peak = 0, n = 0;
  const fetchFn = (async (url: string, init?: RequestInit) => {
    log.push(`${init?.method} ${url}`);
    if (url === '/api/upload/start') { open++; peak = Math.max(peak, open); return Response.json({ id: `u${++n}` }); }
    if (init?.method === 'DELETE') { open--; return Response.json({ ok: true }); }
    await new Promise((resolve) => setTimeout(resolve, pause));
    open--;
    return Response.json({ done: true, name: 'n (1).jpg' });
  }) as typeof fetch;
  return { fetchFn, log, peak: () => peak };
}
const blob = (name: string, size = 3) => Object.assign(new Blob([new Uint8Array(size)]), { name }) as any as File;
// Waits for what the queue does in its own time: as long as it takes, but not for ever.
async function until(done: () => boolean, ms = 3000): Promise<void> {
  for (const end = Date.now() + ms; !done(); await new Promise((resolve) => setTimeout(resolve, 2))) if (Date.now() > end) throw new Error('timed out');
}

test('the queue runs two uploads at a time, in the order given, and says so when it is empty, with how many files went up', async () => {
  const { fetchFn, peak } = pausingServer();
  let last: UploadProgress[] = [];
  const idles: number[] = [];
  const queue = createUploadQueue({ onChange: (items) => { last = items; }, onIdle: (uploaded) => { idles.push(uploaded); }, fetchFn });
  queue.add([blob('a.jpg'), blob('b.jpg'), blob('c.jpg'), blob('d.jpg'), blob('e.jpg')], '/Fam');
  assert.deepEqual(last.map((u) => u.state), ['uploading', 'uploading', 'queued', 'queued', 'queued']);
  await until(() => idles.length > 0);
  assert.equal(peak(), 2);
  assert.deepEqual(idles, [5]);                // once, when the last is done, with how many went up
  assert.deepEqual(last.map((u) => [u.name, u.state, u.sent, u.finalName]), ['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg', 'e.jpg'].map((name) => [name, 'done', 3, 'n (1).jpg']));
});

test('the queue: a failed file is an error with the server\'s words, the others go on, and a second batch joins the first', async () => {
  const fetchFn = (async (url: string, init?: RequestInit) => {
    if (url === '/api/upload/start') {
      const { name } = JSON.parse(init!.body as string);
      return name === 'bad.txt' ? Response.json({ error: 'Only photos and videos can be uploaded' }, { status: 415 }) : Response.json({ id: name });
    }
    return Response.json({ done: true, name: 'ok.jpg' });
  }) as typeof fetch;
  let last: UploadProgress[] = [];
  const idles: number[] = [];
  const queue = createUploadQueue({ onChange: (items) => { last = items; }, onIdle: (uploaded) => { idles.push(uploaded); }, fetchFn });
  queue.add([blob('bad.txt'), blob('a.jpg')], '/Fam');
  await until(() => idles.length === 1);
  queue.add([blob('b.jpg')], '/Fam/Sub');
  await until(() => idles.length === 2);
  assert.deepEqual(last.map((u) => [u.name, u.state, u.error]), [['bad.txt', 'error', 'Only photos and videos can be uploaded'], ['a.jpg', 'done', undefined], ['b.jpg', 'done', undefined]]);
  assert.deepEqual(idles, [1, 1]);             // the failed file is not counted, and the count starts again with each batch
});

test('the queue: cancelling a waiting file means it never starts; cancelling a running one aborts it and drops the upload', async () => {
  const log: string[] = [];
  let n = 0;
  const fetchFn = (async (url: string, init?: RequestInit) => {
    log.push(`${init?.method} ${url}`);
    if (url === '/api/upload/start') return Response.json({ id: `u${++n}` });
    if (init?.method === 'DELETE') return Response.json({ ok: true });
    return new Promise<Response>((_, reject) => init!.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
  }) as typeof fetch;
  let last: UploadProgress[] = [];
  const idles: number[] = [];
  const queue = createUploadQueue({ onChange: (items) => { last = items; }, onIdle: (uploaded) => { idles.push(uploaded); }, fetchFn });
  queue.add([blob('a.jpg'), blob('b.jpg'), blob('c.jpg')], '/Fam');
  await until(() => log.filter((l) => l.startsWith('PUT')).length === 2);   // both are sending their first chunk
  assert.deepEqual(last.map((u) => u.state), ['uploading', 'uploading', 'queued']);
  queue.cancel(2);
  assert.deepEqual(last.map((u) => u.state), ['uploading', 'uploading', 'cancelled']);
  queue.cancel(0);
  await until(() => last[0].state === 'cancelled');
  assert.deepEqual(last.map((u) => u.state), ['cancelled', 'uploading', 'cancelled']);
  assert.deepEqual(idles, []);                 // b is still going
  queue.cancel(1);
  await until(() => idles.length === 1);
  assert.deepEqual(last.map((u) => u.state), ['cancelled', 'cancelled', 'cancelled']);
  assert.deepEqual(idles, [0]);                // nothing went up: the folder is as it was
  assert.equal(log.filter((l) => l === 'POST /api/upload/start').length, 2);   // c was never started
  assert.deepEqual(log.filter((l) => l.startsWith('DELETE')).sort(), ['DELETE /api/upload/u1', 'DELETE /api/upload/u2']);
  queue.cancel(1);                              // a finished one cannot be cancelled again
  queue.clear();
  assert.deepEqual(last, []);
});

test('the queue: clear forgets only when nothing is running', async () => {
  const { fetchFn } = pausingServer(10);
  let last: UploadProgress[] = [];
  const idles: number[] = [];
  const queue = createUploadQueue({ onChange: (items) => { last = items; }, onIdle: (uploaded) => { idles.push(uploaded); }, fetchFn });
  queue.add([blob('a.jpg')], '/Fam');
  queue.clear();
  assert.equal(last.length, 1);
  await until(() => idles.length === 1);
  queue.clear();
  assert.deepEqual(last, []);
});

test('uploadSummary: what the panel says in its header', () => {
  const u = (state: UploadProgress['state']): UploadProgress => ({ name: 'x', size: 1, sent: 0, state });
  assert.equal(uploadSummary([]), '');
  assert.equal(uploadSummary([u('uploading')]), 'Uploading 1 file');
  assert.equal(uploadSummary([u('uploading'), u('queued'), u('done')]), 'Uploading 2 files');
  assert.equal(uploadSummary([u('done'), u('done')]), '2 uploaded');
  assert.equal(uploadSummary([u('done'), u('error'), u('error'), u('cancelled')]), '1 uploaded · 2 failed · 1 cancelled');
  assert.equal(uploadSummary([u('cancelled')]), '1 cancelled');
  assert.equal(uploadSummary([u('error')]), '1 failed');
});

test('filesOf: the files of a drop, and whether a folder was among it', () => {
  const a = new Blob(['a']) as any as File, b = new Blob(['b']) as any as File;
  const item = (kind: string, dir: boolean, file: File | null) => ({ kind, webkitGetAsEntry: () => ({ isDirectory: dir }), getAsFile: () => file });
  const drop = (...items: ReturnType<typeof item>[]) => ({ items }) as unknown as DataTransfer;
  assert.deepEqual(filesOf(drop(item('file', false, a), item('file', false, b))), { files: [a, b], folders: false });
  assert.deepEqual(filesOf(drop(item('file', false, a), item('file', true, null))), { files: [a], folders: true });
  assert.deepEqual(filesOf(drop(item('file', true, null))), { files: [], folders: true });
  assert.deepEqual(filesOf(drop(item('string', false, null))), { files: [], folders: false });   // dragged text is no file
  // a browser that cannot tell a folder from a file (no webkitGetAsEntry) hands everything over; the server refuses what is not media
  const old = { kind: 'file', getAsFile: () => a };
  assert.deepEqual(filesOf({ items: [old] } as unknown as DataTransfer), { files: [a], folders: false });
});
