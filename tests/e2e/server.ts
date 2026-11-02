import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const E2E_PORT = 4341;
export const E2E_RESULTS = join(tmpdir(), "docleus-collab-e2e-results");

const CORE = fileURLToPath(new URL("../../../docleus-core", import.meta.url));
const BUNDLE = fileURLToPath(new URL("bundle.yaml", import.meta.url));
const READY_URL = `http://127.0.0.1:${String(E2E_PORT)}/api/auth/methods`;
const START_TIMEOUT_MS = 60_000;

export interface E2eServer {
  stop(): Promise<void>;
}

async function waitUntilReady(child: ChildProcess): Promise<void> {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`the server exited with ${String(child.exitCode)}`);
    }
    try {
      const response = await fetch(READY_URL);
      if (response.ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("the server did not start in time");
}

/**
 * Serves the bundle from `data`, in development mode. Runs the CLI with
 * Node directly so that SIGTERM reaches it and it shuts down cleanly.
 */
export async function startServer(data: string): Promise<E2eServer> {
  const child = spawn(
    process.execPath,
    [
      "scripts/dev.ts",
      "serve",
      "--dev",
      "--bundle",
      BUNDLE,
      "--data",
      data,
      "--port",
      String(E2E_PORT),
    ],
    { cwd: CORE, stdio: ["ignore", "inherit", "inherit"] },
  );
  try {
    await waitUntilReady(child);
  } catch (error) {
    child.kill("SIGKILL");
    throw error;
  }
  return {
    async stop() {
      if (child.exitCode !== null) return;
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await exited;
    },
  };
}
