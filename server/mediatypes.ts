import type { MediaKind } from '../shared/types.ts';
import { splitExt } from './names.ts';

export interface MediaType { kind: MediaKind; mime: string; label: string; viewMime?: string; convert?: boolean }

// Keyed by lowercase extension. viewMime is the type to serve for viewing; convert means HEIC/HEIF previews are made as JPEG.
export const MEDIA_TYPES: Record<string, MediaType> = {
  '.jpg': { kind: 'photo', mime: 'image/jpeg', label: 'JPEG image' },
  '.jpeg': { kind: 'photo', mime: 'image/jpeg', label: 'JPEG image' },
  '.png': { kind: 'photo', mime: 'image/png', label: 'PNG image' },
  '.webp': { kind: 'photo', mime: 'image/webp', label: 'WebP image' },
  '.gif': { kind: 'photo', mime: 'image/gif', label: 'GIF image' },
  '.heic': { kind: 'photo', mime: 'image/heic', label: 'HEIC image', convert: true },
  '.heif': { kind: 'photo', mime: 'image/heif', label: 'HEIF image', convert: true },
  '.mp4': { kind: 'video', mime: 'video/mp4', label: 'MP4 video' },
  '.m4v': { kind: 'video', mime: 'video/x-m4v', label: 'M4V video', viewMime: 'video/mp4' },
  '.mov': { kind: 'video', mime: 'video/quicktime', label: 'MOV video', viewMime: 'video/mp4' },
  '.webm': { kind: 'video', mime: 'video/webm', label: 'WebM video' },
};

const extOf = (name: string) => splitExt(name.toLowerCase())[1];

export function mediaTypeOf(name: string): MediaType | null {
  return MEDIA_TYPES[extOf(name)] ?? null;
}

const sigAt = (head: Buffer, offset: number, ...alts: string[]) =>
  alts.some((s) => head.subarray(offset, offset + s.length).equals(Buffer.from(s, 'latin1')));

// ponytail: signature only, no container parse; a crafted file can still pass.
export function checkMagic(name: string, head: Buffer): boolean {
  switch (extOf(name)) {
    case '.jpg':
    case '.jpeg':
      return sigAt(head, 0, '\xff\xd8\xff');
    case '.png':
      return sigAt(head, 0, '\x89PNG\r\n\x1a\n');
    case '.gif':
      return sigAt(head, 0, 'GIF87a', 'GIF89a');
    case '.webp':
      return sigAt(head, 0, 'RIFF') && sigAt(head, 8, 'WEBP');
    case '.heic':
    case '.heif':
    case '.mp4':
    case '.m4v':
      return sigAt(head, 4, 'ftyp');
    case '.mov':
      return sigAt(head, 4, 'ftyp', 'moov', 'mdat', 'wide', 'free', 'skip');
    case '.webm':
      return sigAt(head, 0, '\x1a\x45\xdf\xa3');
    default:
      return false;
  }
}
