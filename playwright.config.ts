import { defineConfig, devices } from "@playwright/test";
import { E2E_PORT, E2E_RESULTS } from "./tests/e2e/server.ts";

// The tests start and stop the server themselves, to restart it mid-edit;
// the global setup builds what it serves.
export default defineConfig({
  testDir: "tests/e2e",
  globalSetup: "./tests/e2e/global-setup.ts",
  // Traces stay out of the repository, which does not ignore test-results/.
  outputDir: E2E_RESULTS,
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  reporter: "list",
  timeout: 120_000,
  use: {
    baseURL: `http://127.0.0.1:${String(E2E_PORT)}`,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
