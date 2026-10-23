// The design's controls. Looks are copied from docs/design/Gallery Explorer.dc.html (SEG line 521, the toggle line 254, the modal lines 218-266).

import { Fragment, useEffect, useRef } from 'react';
import type { ButtonHTMLAttributes, CSSProperties, InputHTMLAttributes, ReactNode } from 'react';
import { avatarColor, initials } from '../lib/format.ts';

// Segmented control: the chosen option is a raised white pill. As in Settings its text is bold and blue; `plain` leaves it as it is, as the design's dialogs do.
// `fill` shares the width between the options, also as the design does in a dialog.
export function Seg<T extends string>({ options, value, onChange, fill, plain, style }: {
  options: [value: T, label: ReactNode][]; value: T; onChange(value: T): void; fill?: boolean; plain?: boolean; style?: CSSProperties;
}) {
  return (
    <div role="group" style={{ display: 'flex', gap: 2, padding: 2, background: '#eceef2', borderRadius: 7, ...style }}>
      {options.map(([key, label]) => {
        const on = key === value;
        const accent = on && !plain;
        return (
          <button key={key} type="button" aria-pressed={on} onClick={() => onChange(key)} style={{
            flex: fill ? 1 : undefined, height: fill ? 30 : 28, padding: fill ? 0 : '0 12px', border: 'none', borderRadius: 5, cursor: 'pointer', whiteSpace: 'nowrap',
            background: on ? '#fff' : 'transparent', boxShadow: on ? '0 1px 2px rgba(0,0,0,.12)' : 'none', color: accent ? '#005fb8' : plain ? '#1b1b1f' : '#3a3e46', fontWeight: accent ? 600 : 400,
          }}>{label}</button>
        );
      })}
    </div>
  );
}

// A row with the label on the left and the switch on the right; the whole row is the button.
export function Toggle({ checked, onChange, label, style }: { checked: boolean; onChange(checked: boolean): void; label: ReactNode; style?: CSSProperties }) {
  return (
    <button type="button" role="switch" aria-checked={checked} onClick={() => onChange(!checked)} style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', height: 40, padding: 0, border: 'none', background: 'none', color: 'inherit',
      textAlign: 'left', cursor: 'pointer', ...style,
    }}>
      <span>{label}</span>
      <span style={{
        position: 'relative', width: 40, height: 20, borderRadius: 10, flexShrink: 0, transition: 'background .15s',
        background: checked ? '#005fb8' : 'transparent', border: `1px solid ${checked ? '#005fb8' : '#8a8f99'}`,
      }}>
        <span style={{ position: 'absolute', top: 3, left: checked ? 23 : 3, width: 12, height: 12, borderRadius: '50%', background: checked ? '#fff' : '#5c616b', transition: 'left .15s' }} />
      </span>
    </button>
  );
}

// `type` is 'button' unless a form's submit button says otherwise. `danger` is the red outline of the design's "Remove user".
export function Button({ variant = 'default', ...rest }: { variant?: 'primary' | 'danger' | 'default' } & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className'>) {
  return <button type="button" className={variant === 'default' ? 'btn' : `btn ${variant}`} {...rest} />;
}

// A label above a text box.
export function Field({ label, ...input }: { label: string } & Omit<InputHTMLAttributes<HTMLInputElement>, 'className'>) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span style={{ fontSize: 12, color: '#4a4e57' }}>{label}</span>
      <input className="field" {...input} />
    </label>
  );
}

// The coloured circle with the initials. Next to the name, so it says nothing to a screen reader.
export function Avatar({ id, name, size = 24 }: { id: number; name: string; size?: number }) {
  return (
    <div aria-hidden="true" style={{
      width: size, height: size, borderRadius: '50%', flexShrink: 0, background: avatarColor(id), color: '#fff', fontSize: Math.floor(size / 4 + 4), fontWeight: 600,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>{initials(name)}</div>
  );
}

// A path on disk that a narrow cell may wrap after any slash. (A zero-width space would do that too, but it would be copied along with the text.)
export function Path({ text }: { text: string }) {
  return text.split('/').map((part, i) => <Fragment key={i}>{i > 0 && <>/<wbr /></>}{part}</Fragment>);
}

// A card in the middle of the window over a dimmed page, the design's modal. It is a modal <dialog>, so the focus stays inside it, the page behind is inert
// and Esc asks to close it. Whoever renders it decides when it goes: onClose is a request, for Esc and for a click on the backdrop.
export function Dialog({ onClose, width = 420, label, style, children }: { onClose(): void; width?: number; label?: string; style?: CSSProperties; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  const downOnBackdrop = useRef(false);
  useEffect(() => {
    const dialog = ref.current!;
    const opener = document.activeElement;
    if (!dialog.open) dialog.showModal();
    return () => { if (opener instanceof HTMLElement) opener.focus(); };   // an element taken out of the page doesn't give the focus back by itself
  }, []);
  // React passes these two events up to the dialog around this one (a dialog inside a dialog), though the browser doesn't: only the dialog itself answers.
  return (
    <dialog ref={ref} className="dlg" aria-label={label} style={{ width, ...style }}
      onClose={(e) => { if (e.target === e.currentTarget) onClose(); }}
      onCancel={(e) => { if (e.target === e.currentTarget) { e.preventDefault(); onClose(); } }}
      // a press that began inside (selecting the text of a field) and ended on the backdrop is not a click on it
      onMouseDown={(e) => { downOnBackdrop.current = e.target === e.currentTarget; }}
      onClick={(e) => { if (downOnBackdrop.current && e.target === e.currentTarget) onClose(); }}>
      {children}
    </dialog>
  );
}
