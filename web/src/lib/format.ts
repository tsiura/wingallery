// How the design writes dates, sizes, durations, counts and avatars. en-US, whatever the browser's locale.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n: number, width = 2): string => String(n).padStart(width, '0');

// "2026-03-14T09:00:00" -> "Mar 14, 2026  09:00" (two spaces, 24 h). A wall clock is what the camera said, so it is read as text: no zone may move it.
// Anything that isn't one comes back as it is.
export function fmtDate(wallClock: string): string {
  const m = /^(\d{4})-(\d\d)-(\d\d)[T ](\d\d):(\d\d)/.exec(wallClock);
  return m ? `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}  ${m[4]}:${m[5]}` : wallClock;
}

// An instant (ms since the epoch, as a folder's mtime comes) as the wall clock of this browser's own zone.
export function fmtEpoch(ms: number): string {
  const d = new Date(ms);
  return fmtDate(`${pad(d.getFullYear(), 4)}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`);
}

// "1 item", "2 items": the count with the word that goes with it.
export const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

export const fmtSize = (bytes: number): string =>
  bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.round(bytes / 1e3)} KB`;

// m:ss, in whole seconds (ffprobe gives fractions).
export function fmtDur(seconds: number): string {
  const s = Math.floor(seconds);
  return `${Math.floor(s / 60)}:${pad(s % 60)}`;
}

// The first letters of the first two words; '?' for a name with none. Spread, so a letter outside the BMP isn't cut in half.
export const initials = (name: string): string =>
  name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => [...w][0]).join('').toUpperCase() || '?';

const AVATAR_COLORS = ['#005fb8', '#8a5a00', '#2f7d32', '#a4373a', '#5c2e91', '#00737a'];
export const avatarColor = (id: number): string => AVATAR_COLORS[id % AVATAR_COLORS.length];
