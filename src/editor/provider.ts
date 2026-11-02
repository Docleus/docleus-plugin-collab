import {
  DocleusError,
  z,
  type EditorCollaborationProvider,
  type EditorCollaborationSession,
  type UiService,
} from "@docleus/sdk";
import * as Y from "yjs";
import {
  COLLAB_FRAGMENT,
  COLLAB_PATH,
  collabStatusPath,
  documentNameOf,
  parseCollabMessage,
  type CollabMessage,
  type CollabStatus,
} from "../shared/index.ts";

/** How long an explicit save may take before it counts as failed. */
export const SAVE_TIMEOUT_MS = 15_000;

/** How long the first sync may take before the page opens alone. */
export const SYNC_TIMEOUT_MS = 10_000;

/** What a session needs from a connected Hocuspocus provider. */
export interface CollabConnection {
  /** The provider handed to the editor, for its awareness. */
  readonly provider: unknown;
  sendStateless(payload: string): void;
  destroy(): void;
}

/** Callbacks a {@link CollabConnection} reports to. */
export interface CollabConnectionEvents {
  onSynced(): void;
  onAuthenticationFailed(reason: string): void;
  onStateless(payload: string): void;
}

export interface CollabConnectOptions extends CollabConnectionEvents {
  readonly url: string;
  readonly name: string;
  readonly document: Y.Doc;
  readonly token: string;
}

export interface CollabProviderOptions {
  readonly ui: Pick<UiService, "request">;
  /** The WebSocket URL of the collaboration server. */
  readonly url: string;
  readonly connect: (options: CollabConnectOptions) => CollabConnection;
  readonly createId?: () => string;
}

/** `ws(s)://<host>/api/collab` for the page the editor runs in. */
export function collabUrlOf(location: Pick<Location, "protocol" | "host">) {
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${location.host}${COLLAB_PATH}`;
}

const statusSchema: z.ZodType<CollabStatus> = z.discriminatedUnion("canShare", [
  z.object({
    canShare: z.literal(true),
    user: z.object({ name: z.string(), color: z.string() }),
  }),
  z.object({ canShare: z.literal(false), reason: z.string() }),
]);

async function statusOf(
  ui: Pick<UiService, "request">,
  path: string,
): Promise<CollabStatus> {
  const response = await ui.request(path);
  if (!response.ok) {
    throw new DocleusError(
      "collab/status-failed",
      `the collaboration status request failed with ${String(response.status)}`,
    );
  }
  const status = statusSchema.safeParse(await response.json());
  if (!status.success) {
    throw new DocleusError(
      "collab/status-failed",
      "the collaboration status answer is malformed",
    );
  }
  return status.data;
}

interface Deferred {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
}

function createDeferred(): Deferred {
  const handlers: Partial<Omit<Deferred, "promise">> = {};
  const promise = new Promise<void>((resolve, reject) => {
    Object.assign(handlers, { resolve, reject });
  });
  return {
    promise,
    resolve: () => handlers.resolve?.(),
    reject: (error) => handlers.reject?.(error),
  };
}

interface PendingSave {
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

/**
 * A collaboration provider for the editor: asks the status route whether
 * the page can be edited together, then connects its shared document.
 * Pages the user cannot share open in single-user mode.
 */
export function createCollabProvider(
  options: CollabProviderOptions,
): EditorCollaborationProvider {
  const createId = options.createId ?? (() => crypto.randomUUID());
  return async (target) => {
    const status = await statusOf(
      options.ui,
      collabStatusPath(
        target.orgId,
        target.spaceId,
        target.entryId,
        target.branch,
      ),
    );
    if (!status.canShare) return undefined;

    const document = new Y.Doc();
    const saves = new Map<string, PendingSave>();
    const {
      promise: synced,
      resolve: markSynced,
      reject: failSync,
    } = createDeferred();
    const syncTimer = setTimeout(() => {
      failSync(
        new DocleusError(
          "collab/sync-timeout",
          "the collaboration server did not answer in time",
        ),
      );
    }, SYNC_TIMEOUT_MS);

    const settle = (id: string, error?: Error) => {
      const pending = saves.get(id);
      if (!pending) return;
      saves.delete(id);
      clearTimeout(pending.timer);
      if (error) pending.reject(error);
      else pending.resolve();
    };

    const connection = options.connect({
      url: options.url,
      name: documentNameOf(target),
      document,
      token: JSON.stringify(target.schema ?? null),
      onSynced: () => {
        clearTimeout(syncTimer);
        markSynced();
      },
      onAuthenticationFailed: (reason) => {
        clearTimeout(syncTimer);
        failSync(
          new DocleusError(
            "collab/denied",
            `shared editing refused: ${reason}`,
          ),
        );
      },
      onStateless: (payload) => {
        const message = parseCollabMessage(payload);
        if (message?.type === "saved") settle(message.id);
        if (message?.type === "save-failed") {
          settle(
            message.id,
            new DocleusError("collab/save-failed", message.message),
          );
        }
      },
    });

    const session: EditorCollaborationSession = {
      document,
      fragment: COLLAB_FRAGMENT,
      provider: connection.provider,
      user: status.user,
      synced,
      save: () =>
        new Promise<void>((resolve, reject) => {
          const id = createId();
          const timer = setTimeout(() => {
            settle(
              id,
              new DocleusError(
                "collab/save-timeout",
                "the collaboration server did not confirm the save",
              ),
            );
          }, SAVE_TIMEOUT_MS);
          saves.set(id, { resolve, reject, timer });
          const message: CollabMessage = { type: "save", id };
          connection.sendStateless(JSON.stringify(message));
        }),
      dispose: () => {
        clearTimeout(syncTimer);
        for (const id of saves.keys()) {
          settle(
            id,
            new DocleusError("collab/closed", "the editor was closed"),
          );
        }
        connection.destroy();
        document.destroy();
      },
    };
    return session;
  };
}
