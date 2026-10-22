export type Role = 'admin' | 'member';
export type ViewMode = 'large' | 'medium' | 'details';
export interface Prefs { defaultView: ViewMode; slideSeconds: number }          // defaults { 'large', 5 }
export interface Me { id: number; username: string; displayName: string; role: Role; prefs: Prefs }
export interface SessionInfo { user: Me | null; setupRequired: boolean }
export interface Rights { create: boolean; update: boolean; delete: boolean }   // read is implied
export type MediaKind = 'photo' | 'video';
export interface FolderEntry { kind: 'folder'; name: string; mtime: number; count: number; cover: string | null; protected: boolean; unavailable?: boolean }
export interface FileEntry { kind: MediaKind; name: string; size: number; mtime: number; takenAt: string; width: number | null; height: number | null; duration: number | null; type: string }
export type Entry = FolderEntry | FileEntry;
export interface Listing { path: string; name: string; rights: Rights; entries: Entry[] }
export interface FolderNode { name: string; count: number; hasChildren: boolean; unavailable?: boolean }
export interface Meta { width: number | null; height: number | null; takenAt: string; duration: number | null }
export interface SlideItem { path: string; kind: MediaKind; name: string; mtime: number }
export interface AdminUser { id: number; username: string; displayName: string; role: Role }
export interface ShareInfo { id: number; userId: number; alias: string; relPath: string; diskPath: string; create: boolean; update: boolean; delete: boolean; available: boolean }
export interface TrashItem { id: string; name: string; originalPath: string; isDir: boolean; size: number; hiddenFiles: number; deletedBy: string; deletedAt: number }
export interface DeletePreview { items: number; hiddenFiles: number }
