import { BlockList, isIP } from 'node:net';
import { join, resolve } from 'node:path';

export interface Config {
  mediaRoot: string; dataDir: string; port: number; trustedProxies: BlockList;
  cookieSecure: boolean; maxUploadBytes: number; trashDays: number; webDist: string;
}

const DEFAULT_PROXIES = '127.0.0.0/8,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,::1/128,fc00::/7';

// Unset or empty means the default; anything but a plain whole number is a startup error
// (a NaN upload limit would silently disable the cap).
function whole(env: NodeJS.ProcessEnv, name: string, def: number): number {
  const raw = env[name];
  if (!raw) return def;
  if (!/^\d+$/.test(raw)) throw new Error(`Invalid ${name}: ${raw}`);
  return Number(raw);
}

// Entries are CIDR ranges or bare IPs, IPv4 or IPv6.
function proxyList(spec: string): BlockList {
  const list = new BlockList();
  for (const part of spec.split(',')) {
    const entry = part.trim();
    if (!entry) continue;
    const [addr, bits, ...extra] = entry.split('/');
    const version = isIP(addr);
    const family = version === 4 ? 'ipv4' : 'ipv6';
    const prefix = bits === undefined ? 0 : /^\d+$/.test(bits) ? Number(bits) : -1;
    if (!version || extra.length || prefix < 0 || prefix > (version === 4 ? 32 : 128))
      throw new Error(`Invalid TRUSTED_PROXIES entry: ${entry}`);
    if (bits === undefined) list.addAddress(addr, family);
    else list.addSubnet(addr, prefix, family);
  }
  return list;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    mediaRoot: resolve(env.MEDIA_ROOT || '/media'),
    dataDir: resolve(env.DATA_DIR || '/data'),
    port: whole(env, 'PORT', 8080),
    trustedProxies: proxyList(env.TRUSTED_PROXIES || DEFAULT_PROXIES),
    cookieSecure: env.COOKIE_SECURE !== 'false',
    maxUploadBytes: whole(env, 'MAX_UPLOAD_MB', 10240) * 1024 * 1024,
    trashDays: whole(env, 'TRASH_DAYS', 30),
    webDist: resolve(env.WEB_DIST || join(import.meta.dirname, '..', 'web', 'dist')),
  };
}
