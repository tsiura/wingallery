import { execFile } from 'node:child_process';

// Runs an external tool and resolves with its stdout. No shell: `args` reach the program as they are. A tool that exits non-zero, can't be
// started or outlives the timeout rejects with its stderr (or what Node says when it has none). Tests pass their own RunFn in place of this.
// The timeout kills with SIGKILL: execFile answers only once the child has exited, and ffmpeg catches SIGTERM, so a decoder that is stuck would
// otherwise never settle this promise, and its caller (and the limiter slot it holds) would wait for good.
export type RunFn = (cmd: string, args: string[], timeoutMs: number) => Promise<string>;

export const runProcess: RunFn = (cmd, args, timeoutMs) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${cmd} failed: ${stderr || err.message}`));
      else resolve(stdout);
    });
  });
