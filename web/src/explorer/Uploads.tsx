import { useEffect, useState } from 'react';
import type { RefObject } from 'react';
import { createUploadQueue, filesOf } from '../lib/upload.ts';
import type { UploadProgress } from '../lib/upload.ts';
import { UploadPanel } from './UploadPanel.tsx';

const FOLDERS_NOT_UPLOADED = "Folders can't be uploaded — select files instead.";

// Everything about uploading, as a component of its own: the queue, the file input behind the Upload button, the files dropped on the items pane and the panel
// that shows how far each file is. The progress changes the state every few hundred milliseconds, and it re-renders this component and nothing else: not the
// Explorer, not the items.
// `area` is the pane that files are dropped on (a dashed outline marks it while files are over it) and `picker` the file input, which the Upload button clicks;
// both belong to Explorer's page and are handed in. `onNotice` is for what could not be done, `onPicked` for when a pick is over, and `onUploaded` for when files
// have gone up and the folder is to be read again.
export function Uploads({ area, picker, vpath, canUpload, onNotice, onUploaded, onPicked }: {
  area: RefObject<HTMLElement | null>; picker: RefObject<HTMLInputElement | null>; vpath: string; canUpload: boolean;
  onNotice(message: string | null): void; onUploaded(): void; onPicked(): void;
}) {
  const [uploads, setUploads] = useState<UploadProgress[]>([]);
  const [dragging, setDragging] = useState(false);   // files are being dragged over the pane
  // The queue lives as long as this component. It is made once, with the first render's `onUploaded`, which is as good as any later one: it is the Explorer's
  // `reload`, which only touches refs and setters. When the queue runs empty the folder is read again, if a file went up: a drop that all failed (a connection
  // that is gone) must not end in a failed reload, which would replace the folder with "unavailable".
  const [queue] = useState(() => createUploadQueue({ onChange: setUploads, onIdle: (uploaded) => { if (uploaded > 0) onUploaded(); } }));

  // A file dropped on anything but the pane would open in this tab and take the app, and the uploads in it, away. The pane's own handlers have already answered.
  useEffect(() => {
    const refuse = (e: DragEvent) => {
      if (e.defaultPrevented || !e.dataTransfer?.types.includes('Files')) return;
      e.preventDefault();
      if (e.type !== 'drop') e.dataTransfer.dropEffect = 'none';
    };
    const events = ['dragenter', 'dragover', 'drop'] as const;
    for (const type of events) document.addEventListener(type, refuse);
    return () => { for (const type of events) document.removeEventListener(type, refuse); };
  }, []);

  // Files dragged over the pane. Only files count (the page's own images and text are dragged too), and without the right to create here, the drop is refused.
  // The answer is given on entering as well as over: a browser that keeps to the specification to the letter takes only an entered target for a drop target.
  useEffect(() => {
    const pane = area.current;
    if (!pane) return;
    const hasFiles = (e: DragEvent) => e.dataTransfer?.types.includes('Files') === true;
    const over = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer!.dropEffect = canUpload ? 'copy' : 'none';
      if (canUpload) setDragging(true);
    };
    // Leaving for a child of the pane is a leave too, so the pointer's place says whether it left the pane.
    const leave = (e: DragEvent) => {
      const box = pane.getBoundingClientRect();
      if (e.clientX <= box.left || e.clientX >= box.right || e.clientY <= box.top || e.clientY >= box.bottom) setDragging(false);
    };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      setDragging(false);
      if (!canUpload) return;
      const { files, folders } = filesOf(e.dataTransfer!);
      onNotice(folders ? FOLDERS_NOT_UPLOADED : null);
      queue.add(files, vpath);
    };
    pane.addEventListener('dragenter', over);
    pane.addEventListener('dragover', over);
    pane.addEventListener('dragleave', leave);
    pane.addEventListener('drop', drop);
    return () => {
      pane.removeEventListener('dragenter', over);
      pane.removeEventListener('dragover', over);
      pane.removeEventListener('dragleave', leave);
      pane.removeEventListener('drop', drop);
    };
  }, [area, canUpload, vpath]);

  // The outline is the stylesheet's (`.dropping`). A drag that is cancelled (Esc) leaves from inside the pane: the mouse moving again, which it can't while the
  // drag lasts, says it is over.
  useEffect(() => {
    const pane = area.current;
    if (!pane || !dragging) return;
    const over = () => setDragging(false);
    pane.classList.add('dropping');
    pane.addEventListener('mousemove', over);
    return () => { pane.classList.remove('dropping'); pane.removeEventListener('mousemove', over); };
  }, [area, dragging]);

  return (
    <>
      {canUpload && (
        <input ref={picker} type="file" multiple accept="image/*,video/*,.heic,.heif" hidden
          onChange={(e) => { onNotice(null); queue.add(Array.from(e.target.files ?? []), vpath); e.target.value = ''; onPicked(); }} />
      )}
      {uploads.length > 0 && <UploadPanel items={uploads} onCancel={queue.cancel} onClose={queue.clear} />}
    </>
  );
}
