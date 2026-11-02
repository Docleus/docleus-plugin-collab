import {
  DocleusError,
  definePlugin,
  z,
  type DocleusPlugin,
} from "@docleus/sdk";
import { PLUGIN_NAME } from "../shared/index.ts";
import { registerCollab } from "./collab.ts";
import { registerRoutes } from "./routes.ts";
import { createCollabStore } from "./store.ts";

/** How long a shared page stays untouched before it is committed, by default. */
export const DEFAULT_IDLE_DELAY_MS = 3_000;

/** The plugin config, as written in the bundle. */
export interface CollabConfig {
  /** Milliseconds without edits after which a shared page is committed. */
  readonly idleDelay: number;
}

const configSchema = z
  .object(
    {
      idleDelay: z
        .number({
          error: '"idleDelay" must be a positive number of milliseconds',
        })
        .positive('"idleDelay" must be a positive number of milliseconds')
        .default(DEFAULT_IDLE_DELAY_MS),
    },
    { error: "the config must be an object" },
  )
  .nullish();

/** Validates the plugin config; an invalid one fails with `collab/invalid-config`. */
export function parseCollabConfig(value: unknown): CollabConfig {
  const result = configSchema.safeParse(value);
  if (!result.success) {
    throw new DocleusError(
      "collab/invalid-config",
      result.error.issues[0]?.message ?? "the config is invalid",
    );
  }
  return result.data ?? { idleDelay: DEFAULT_IDLE_DELAY_MS };
}

/** Options for {@link createCollabPlugin}, for tests. */
export interface CollabPluginOptions {
  /** The clock, in milliseconds since the epoch. Defaults to `Date.now`. */
  readonly now?: () => number;
  /** Overrides the configured idle delay. */
  readonly idleDelay?: number;
}

/**
 * The collaboration server plugin. Serves one shared Yjs document per page
 * and branch on `/api/collab`, keeps its state in the plugin's own table,
 * and commits it to the branch on idle, on save, on `content/flush`, and
 * when the last editor leaves.
 *
 * @stability experimental
 */
export function createCollabPlugin(
  options: CollabPluginOptions = {},
): DocleusPlugin {
  const now = options.now ?? Date.now;
  return definePlugin({
    name: PLUGIN_NAME,
    inject: [
      "storage",
      "content",
      "http",
      "authz",
      "installations",
      "identity",
    ],
    apply(ctx, config: unknown) {
      const parsed = parseCollabConfig(config);
      const store = createCollabStore(ctx, now);
      registerRoutes(ctx);
      registerCollab(ctx, store, {
        idleDelay: options.idleDelay ?? parsed.idleDelay,
      });
    },
  });
}

/** The plugin as loaded from the manifest's `server` entry. */
export const plugin = createCollabPlugin();
