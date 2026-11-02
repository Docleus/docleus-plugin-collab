import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

// The server loads the built app and the built plugins of every repository
// in the bundle.
const BUILDS = [
  "pnpm --dir ../docleus-core build",
  "pnpm --dir ../docleus-plugin-editor build",
  "pnpm --dir ../docleus-plugin-blocks-commonmark build",
  "pnpm --dir ../docleus-plugin-change-requests build",
  "pnpm build",
];

// oxlint-disable-next-line import/no-default-export -- Playwright loads the global setup as a default export.
export default function globalSetup(): void {
  for (const command of BUILDS) {
    execSync(command, { cwd: ROOT, stdio: "inherit" });
  }
}
