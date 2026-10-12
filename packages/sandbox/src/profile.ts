import { realpathSync } from 'node:fs';
import type { FsPolicy } from './adapter.ts';

/** Seatbelt matches the resolved vnode path, so /tmp and /private/tmp must be unified. */
function real(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * Generate a seatbelt (SBPL) profile for one command.
 *
 * This is the fence that makes "/memory is read-only" a kernel fact rather than a
 * request in a prompt. Later rules win
 * in SBPL, so the profile denies broadly and then re-allows the workspace:
 *
 *   1. allow by default;
 *   2. hide the control plane (database, vault, socket dir, other agents' workspaces);
 *   3. re-allow reads of this agent's workspace and of its read-only roots;
 *   4. deny every write;
 *   5. allow writes inside the workspace only;
 *   6. keep the system readable so a real shell still works;
 *   7. belt and braces: read-only roots are not writable even via a symlink.
 */
export function buildProfile(policy: FsPolicy, cwd: string, network: boolean): string {
  const q = (p: string) => '"' + real(p).replace(/"/g, '\\"') + '"';
  const subpaths = (paths: string[]) => paths.map(q).map((p) => '(subpath ' + p + ')').join(' ');

  const writable = policy.writable.map(real);
  const readable = policy.readable.map(real);
  const ipc = (policy.ipc ?? []).map(real);
  // Drop hidden entries that live *inside* a writable root (they would be re-allowed
  // anyway); keep entries that contain the workspace, because the workspace is re-allowed
  // by an explicit later rule.
  const hidden = policy.hidden.map(real).filter((h) => !writable.some((w) => w.startsWith(h + '/')));

  const lines: string[] = ['(version 1)', '(allow default)'];
  if (hidden.length > 0) lines.push('(deny file-read* file-write* ' + subpaths(hidden) + ')');
  lines.push('(allow file-read* ' + subpaths([...writable, ...readable]) + ')');
  lines.push('(deny file-write*)');
  lines.push(
    '(allow file-write* ' +
      subpaths([...writable, '/dev/null', '/dev/stdout', '/dev/stderr', '/dev/fd', '/dev/tty', '/dev/dtracehelper']) +
      ')'
  );
  lines.push(
    '(allow file-read* (subpath "/usr") (subpath "/bin") (subpath "/sbin") (subpath "/System") (subpath "/Library") (subpath "/opt") (subpath "/private/etc") (subpath "/etc") (subpath "/dev") (subpath "/private/var/db"))'
  );
  if (readable.length > 0) lines.push('(deny file-write* ' + subpaths(readable) + ')');
  // The session's tools socket stays reachable even though the rest of the runtime
  // directory is hidden: the CLI needs it, nothing else does.
  if (ipc.length > 0) {
    lines.push('(allow file-read* file-write* ' + subpaths(ipc) + ')');
    lines.push('(allow network-outbound (remote unix-socket ' + ipc.map((p) => '(path ' + q(p) + ')').join(' ') + '))');
  }
  if (!network) lines.push('(deny network*)');
  void cwd;
  return lines.join('\n');
}
