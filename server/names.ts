// Shared name rules: validation, hidden names, upload sanitizing and collision suffixes.

const BAD_CHARS = /[\/\\:*?"<>|\x00-\x1f\x7f]/;
const HIDDEN = new Set(['@eadir', '#recycle', '#snapshot', '$recycle.bin', 'system volume information', 'lost+found', 'thumbs.db', 'desktop.ini']);
const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

export const naturalCompare = collator.compare;

// The name without its trailing dots and spaces. A loop, not /[. ]+$/: that regex is quadratic on a long run of them (see trimPad).
function stripTail(name: string): string {
  let end = name.length;
  while (end > 0 && (name[end - 1] === '.' || name[end - 1] === ' ')) end--;
  return name.slice(0, end);
}

// Trailing dots and spaces don't count: Windows ignores them and vfat/exFAT drop trailing dots on lookup, so '$RECYCLE.BIN.' opens
// '$RECYCLE.BIN' and realpath hands back the spelling it was given. FAT's 8.3 short names ('GALLER~1') are not matched: FAT32 is unsupported.
export function isHiddenName(name: string): boolean {
  return name.startsWith('.') || HIDDEN.has(stripTail(name).toLowerCase());
}

// Shared rules for names and aliases. The caller decides `tooLong`.
function checkName(name: string, tooLong: boolean): string | null {
  if (name === '') return "Name can't be empty";
  if (tooLong) return 'Name is too long';
  if (BAD_CHARS.test(name)) return "Name can't contain any of: / \\ : * ? \" < > |";
  if (/^[ .]|[ .]$/.test(name)) return "Name can't start or end with a space or a dot";
  if (isHiddenName(name)) return 'That name is reserved';
  return null;
}

export function validateName(name: string, maxBytes = 200): string | null {
  return checkName(name, Buffer.byteLength(name) > maxBytes);
}

export function validateAlias(alias: string): string | null {
  return checkName(alias, [...alias].length > 64);
}

export function splitExt(name: string): [string, string] {
  const i = name.lastIndexOf('.');
  return i > 0 ? [name.slice(0, i), name.slice(i)] : [name, ''];
}

export function nextFreeName(name: string, n: number): string {
  const [base, ext] = splitExt(name);
  return `${base} (${n})${ext}`;
}

export function restoredName(name: string, n: number): string {
  const [base, ext] = splitExt(name);
  return `${base} (restored${n > 1 ? ` ${n}` : ''})${ext}`;
}

// Longest prefix made of whole code points that fits in `max` UTF-8 bytes.
function fitBytes(s: string, max: number): string {
  let out = '', bytes = 0;
  for (const ch of s) {
    bytes += Buffer.byteLength(ch);
    if (bytes > max) break;
    out += ch;
  }
  return out;
}

// Hand-rolled, not a regex: /^[ .]+|[ .]+$/g is quadratic on long runs of spaces or dots.
function trimPad(s: string): string {
  let a = 0, z = s.length;
  while (a < z && (s[a] === ' ' || s[a] === '.')) a++;
  while (z > a && (s[z - 1] === ' ' || s[z - 1] === '.')) z--;
  return s.slice(a, z);
}

export function sanitizeUploadName(name: string): string {
  // Leading and trailing spaces and dots go, since validateName rejects them.
  const clean = trimPad(name.replace(new RegExp(BAD_CHARS, 'g'), '_'));
  const [base, ext] = splitExt(clean);
  const head = fitBytes(base, 200 - Buffer.byteLength(ext));
  // No room left for the base beside the extension, so cut the whole name instead.
  const out = (head ? head + ext : fitBytes(clean, 200)).replace(/[ .]+$/, '');
  return out || 'file';
}
