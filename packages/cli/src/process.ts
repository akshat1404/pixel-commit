import { spawnSync } from "node:child_process";
import net from "node:net";

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function log(message: string): void {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: exists but owned by someone else.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Kill a process and everything it started. On Windows, child.kill() on a
 * shell-spawned command only kills cmd.exe and leaves the real server running.
 * On POSIX the process must have been spawned with `detached: true` (its own
 * process group).
 */
export function killTree(pid: number): void {
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // already gone
    }
  }
}

/** Ask the OS for an unused port. Tiny race until the server binds it; acceptable locally. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

/** Poll until `url` answers. `gone()` returns a reason if the server process died. */
export async function waitForUrl(url: string, timeoutMs: number, gone: () => string | null): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const reason = gone();
    if (reason) throw new Error(`Dev server stopped before responding: ${reason}`);
    try {
      await fetch(url, { signal: AbortSignal.timeout(2000) });
      return; // any HTTP answer means it is listening
    } catch {
      // not up yet
    }
    await sleep(300);
  }
  throw new Error(`Dev server did not respond on ${url} within ${timeoutMs / 1000}s`);
}
