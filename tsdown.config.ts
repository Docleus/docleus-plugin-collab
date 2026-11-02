import { defineConfig } from "tsdown";

const common = {
  format: "esm",
  dts: false,
  outExtensions: () => ({ js: ".js" }),
} as const;

// The host's import map provides these; `yjs` comes from the editor plugin,
// so the provider and the editor share one Yjs instance.
const HOST_MODULES = [
  "react",
  "react-dom",
  "react/jsx-runtime",
  "react-dom/client",
  "@docleus/sdk",
  "yjs",
];

export default defineConfig([
  {
    ...common,
    entry: {
      "shared/index": "src/shared/index.ts",
      "server/index": "src/server/index.ts",
    },
    clean: ["dist/shared", "dist/server", "dist/*.js"],
  },
  {
    // A browser build of its own, so its chunks stay inside the browser root
    // the host serves: `dist/editor`.
    ...common,
    entry: { index: "src/editor/index.ts" },
    outDir: "dist/editor",
    platform: "browser",
    deps: {
      neverBundle: HOST_MODULES,
      // Runtime dependencies stay external by default; the browser has no
      // node_modules, so the provider and its libraries go into the bundle.
      alwaysBundle: [/^@hocuspocus\//, /^lib0(\/|$)/, /^y-protocols(\/|$)/],
      onlyBundle: false,
    },
    clean: true,
  },
]);
