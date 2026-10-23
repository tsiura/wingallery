// The client side of uploads (server: uploads.ts): one file goes up in 8 MiB chunks, and the queue runs a drop of many files two at a time.

export const CHUNK = 8 * 1024 * 1024;
const PARALLEL = 2;
const LOST = 'Upload interrupted: the connection was lost';

export interface UploadProgress {
  name: string;
  size: number;
  sent: number;                                                              // bytes that the server has confirmed
  state: 'queued' | 'uploading' | 'done' | 'error' | 'cancelled';
  error?: string;
  finalName?: string;                                                        // what the file was saved as: the server adds " (1)" to a name that is taken
}

const cancelled = () => new DOMException('Upload cancelled', 'AbortError');

// One request. The server's refusal throws its own words. A request with no answer at all throws LOST: the server refuses a wrong owner or offset before it
// reads the body and closes the connection, so a browser that is still sending a chunk may see a reset instead of the 404 or 409 (R1). An abort throws AbortError.
async function call(fetchFn: typeof fetch, url: string, init: RequestInit, signal: AbortSignal): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetchFn(url, { ...init, signal });
  } catch {
    throw signal.aborted ? cancelled() : new Error(LOST);
  }
  const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;   // an error page from something in front of the server is not JSON
  if (!res.ok) throw new Error(typeof data?.error === 'string' ? data.error : 'Something went wrong');
  return data ?? {};
}

// Uploads `file` into the folder `dir`, a chunk at a time, one after the other, and resolves with the name it was saved as. `onProgress` is told how many
// bytes are in after each chunk. Any failure is the file's: no chunk is sent twice, nothing is retried (R1), and the half-written upload is dropped on the server
// (best effort, and not waited for: the caller must not be held up by a connection that is down). `signal` cancels: AbortError.
export async function uploadFile(
  file: { name: string; size: number; slice(a: number, b: number): Blob }, dir: string, onProgress: (sent: number) => void, signal: AbortSignal,
  fetchFn: typeof fetch = fetch,
): Promise<string> {
  const started = await call(fetchFn, '/api/upload/start', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dir, name: file.name || 'file', size: file.size }),
  }, signal);
  const id = started.id;
  if (typeof id !== 'string') throw new Error('Something went wrong');
  try {
    for (let offset = 0; offset < file.size;) {
      signal.throwIfAborted();
      const end = Math.min(offset + CHUNK, file.size);
      const reply = await call(fetchFn, `/api/upload/${encodeURIComponent(id)}?offset=${offset}`, {
        method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: file.slice(offset, end),
      }, signal);
      onProgress(end);
      if (reply.done === true && typeof reply.name === 'string') return reply.name;
      if (reply.received !== end) throw new Error('Upload out of sync');
      offset = end;
    }
    throw new Error('The upload did not finish');
  } catch (err) {
    fetchFn(`/api/upload/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {});
    throw signal.aborted ? cancelled() : err;
  }
}

export interface UploadQueue {
  add(files: File[], dir: string): void;      // joins the queue; the files go up in the order given
  cancel(i: number): void;                    // item `i` of the list that onChange gave: a waiting one never starts, a running one is aborted
  clear(): void;                              // forgets the list, once nothing is running
}

// The files of every drop and every pick, in one list (`onChange` gets a new array each time something in it changes), two uploading at a time. `onIdle` is called
// each time the queue has run empty, with how many files went up since the last time: only those have changed the folder (a file that failed or was cancelled is
// gone from the server again, and was never listed), so with none there is nothing to read again.
export function createUploadQueue({ onChange, onIdle, fetchFn = fetch }: {
  onChange(items: UploadProgress[]): void; onIdle(uploaded: number): void; fetchFn?: typeof fetch;
}): UploadQueue {
  const items: UploadProgress[] = [];
  const jobs: { file: File; dir: string; abort: AbortController }[] = [];   // parallel to items
  let running = 0;
  let uploaded = 0;

  const update = (i: number, patch: Partial<UploadProgress>) => { items[i] = { ...items[i], ...patch }; onChange([...items]); };

  function pump(): void {
    for (let i = 0; i < items.length && running < PARALLEL; i++) if (items[i].state === 'queued') start(i);
  }

  function start(i: number): void {
    const { file, dir, abort } = jobs[i];
    running++;
    update(i, { state: 'uploading' });
    uploadFile(file, dir, (sent) => update(i, { sent }), abort.signal, fetchFn).then(
      (finalName) => { uploaded++; update(i, { state: 'done', sent: file.size, finalName }); },
      (err: Error) => update(i, err.name === 'AbortError' ? { state: 'cancelled' } : { state: 'error', error: err.message }),
    ).then(() => {
      running--;
      pump();
      if (running === 0) {
        const count = uploaded;
        uploaded = 0;
        onIdle(count);
      }
    });
  }

  return {
    add(files, dir) {
      if (files.length === 0) return;
      for (const file of files) {
        items.push({ name: file.name, size: file.size, sent: 0, state: 'queued' });
        jobs.push({ file, dir, abort: new AbortController() });
      }
      onChange([...items]);
      pump();
    },
    cancel(i) {
      if (items[i]?.state === 'queued') update(i, { state: 'cancelled' });
      else if (items[i]?.state === 'uploading') jobs[i].abort.abort();
    },
    clear() {
      if (running > 0) return;
      items.length = 0;
      jobs.length = 0;
      onChange([]);
    },
  };
}

// The panel's header: what is going on, or how it went.
export function uploadSummary(items: readonly UploadProgress[]): string {
  const count = (...states: UploadProgress['state'][]) => items.filter((u) => states.includes(u.state)).length;
  const active = count('queued', 'uploading');
  if (active > 0) return `Uploading ${active} ${active === 1 ? 'file' : 'files'}`;
  const outcomes: [number, string][] = [[count('done'), 'uploaded'], [count('error'), 'failed'], [count('cancelled'), 'cancelled']];
  return outcomes.filter(([n]) => n > 0).map(([n, what]) => `${n} ${what}`).join(' · ');
}

// The files of a drop, and whether a folder was in it (a folder can't be uploaded: its files would need a walk and the server has no folder upload). It has to be
// called while the drop event is being handled: afterwards the browser empties the list. A browser without webkitGetAsEntry can't tell the two apart and hands
// everything over; the server refuses what is not a photo or a video.
export function filesOf(dt: DataTransfer): { files: File[]; folders: boolean } {
  const files: File[] = [];
  let folders = false;
  for (const item of Array.from(dt.items)) {
    if (item.kind !== 'file') continue;
    if (item.webkitGetAsEntry?.()?.isDirectory) folders = true;
    else {
      const file = item.getAsFile();
      if (file) files.push(file);
    }
  }
  return { files, folders };
}
