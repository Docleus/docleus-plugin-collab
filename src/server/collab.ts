import { IncomingMessage } from "node:http";
import { Duplex } from "node:stream";
import {
  Hocuspocus,
  type Document,
  type WebSocketLike,
} from "@hocuspocus/server";
import crossws from "crossws/adapters/node";
import {
  DocleusError,
  MAIN_BRANCH,
  REVISION_COMMITTED,
  z,
  type Context,
  type EditorSchemaDescription,
  type LogEntry,
} from "@docleus/sdk";
import * as Y from "yjs";
import {
  COLLAB_FRAGMENT,
  COLLAB_PATH,
  parseCollabMessage,
  parseDocumentName,
  parseSchemaDescription,
  type CollabMessage,
  type CollabTarget,
} from "../shared/index.ts";
import { authorizeCollab, contentOf, editMessage } from "./auth.ts";
import { bodyOfFragment, seedFragment } from "./body.ts";
import { sameTree } from "./reuse.ts";
import type { CollabStore } from "./store.ts";

export interface CollabOptions {
  /** How long a document stays untouched before it is committed, in ms. */
  readonly idleDelay: number;
}

interface CollabContext {
  readonly userId?: string;
  readonly schema?: EditorSchemaDescription;
}

/** What the plugin keeps beside each loaded Hocuspocus document. */
interface DocumentState {
  readonly name: string;
  readonly target: CollabTarget;
  /** The revision the shared document matches, apart from edits since. */
  revision: string;
  schema: EditorSchemaDescription;
  /** The user whose edit came last, who authors the next snapshot. */
  lastEditor: string | undefined;
  lastUser: string;
  idleTimer: ReturnType<typeof setTimeout> | undefined;
}

/** Changes the server makes itself: broadcast, but never stored by Hocuspocus. */
type ClientConnection = ReturnType<Hocuspocus["handleConnection"]>;

const SERVER_ORIGIN = { source: "local", skipStoreHooks: true } as const;

/** Persisting the Yjs state is cheap, so it trails edits closely. */
const STORE_DEBOUNCE_MS = 300;
const STORE_MAX_DEBOUNCE_MS = 1_000;

function createKeyedSerializer(): <T>(
  key: string,
  task: () => Promise<T>,
) => Promise<T> {
  const tails = new Map<string, Promise<unknown>>();
  return (key, task) => {
    const run = (tails.get(key) ?? Promise.resolve()).then(() => task());
    const tail = run.catch(() => undefined);
    tails.set(key, tail);
    void tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key);
    });
    return run;
  };
}

function fragmentOf(document: Y.Doc): Y.XmlFragment {
  return document.getXmlFragment(COLLAB_FRAGMENT);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isWebSocketLike(value: unknown): value is WebSocketLike {
  return (
    isRecord(value) &&
    typeof value.send === "function" &&
    typeof value.close === "function" &&
    typeof value.readyState === "number"
  );
}

function parseToken(token: string): EditorSchemaDescription | undefined {
  try {
    return parseSchemaDescription(JSON.parse(token));
  } catch {
    return undefined;
  }
}

const blockIds = z
  .array(z.unknown())
  .catch([])
  .transform((ids) => ids.filter((id) => typeof id === "string"));

const committedSchema = z.object({
  spaceId: z.string(),
  branch: z.string().catch(MAIN_BRANCH),
  changed: blockIds,
  removed: blockIds,
});

/** The page and branch a commit log entry touched, when it is one. */
function committedOf(
  entry: LogEntry,
): { spaceId: string; branch: string; touched: readonly string[] } | undefined {
  if (entry.type !== REVISION_COMMITTED) return undefined;
  const payload = committedSchema.safeParse(entry.payload).data;
  if (!payload) return undefined;
  const { spaceId, branch, changed, removed } = payload;
  return { spaceId, branch, touched: [...changed, ...removed] };
}

/** Thrown from hooks; Hocuspocus sends `reason` to the provider. */
function denied(reason: string): DocleusError & { readonly reason: string } {
  return Object.assign(
    new DocleusError("collab/denied", `shared editing refused: ${reason}`),
    { reason },
  );
}

/**
 * Serves shared documents on {@link COLLAB_PATH} and keeps them in step with
 * the branch: loads them from the stored Yjs state or the branch head,
 * commits them as revisions, and resets them when someone else commits the
 * page.
 */
export function registerCollab(
  ctx: Context,
  store: CollabStore,
  options: CollabOptions,
): void {
  const logger = ctx.logger("collab");
  const states = new Map<string, DocumentState>();
  const serialize = createKeyedSerializer();
  const connections = new WeakMap<object, ClientConnection>();
  const pendingUpgrades = new WeakMap<Request, { userId: string }>();
  let isClosing = false;

  const hocuspocus = new Hocuspocus<CollabContext>({
    name: "docleus-collab",
    quiet: true,
    debounce: STORE_DEBOUNCE_MS,
    maxDebounce: STORE_MAX_DEBOUNCE_MS,
    async onAuthenticate({ context, documentName, token }) {
      const target = parseDocumentName(documentName);
      if (!target) throw denied("collab/invalid-document");
      if (context.userId === undefined) {
        throw denied("collab/forbidden");
      }
      const access = await authorizeCollab(ctx, context.userId, target);
      if (!access.isAllowed) throw denied(access.reason);
      const schema = parseToken(token);
      return schema ? { schema } : {};
    },
    async onLoadDocument({ document, documentName, context }) {
      await load(document, documentName, context);
    },
    async connected({ documentName, context }) {
      const state = states.get(documentName);
      if (!state) return;
      if (context.schema) state.schema = context.schema;
      if (context.userId !== undefined) state.lastUser = context.userId;
    },
    async onChange({ documentName, transactionOrigin, context }) {
      const state = states.get(documentName);
      const isFromClient =
        isRecord(transactionOrigin) &&
        transactionOrigin.source === "connection";
      if (!state || !isFromClient) return;
      if (context.userId !== undefined) state.lastEditor = context.userId;
      scheduleSnapshot(state);
    },
    async onStoreDocument({ documentName, document }) {
      if (isClosing) return;
      await persist(documentName, document);
    },
    async onStateless({ connection, documentName, payload }) {
      const message = parseCollabMessage(payload);
      if (message?.type !== "save") return;
      let reply: CollabMessage;
      try {
        await serialize(documentName, () => snapshot(documentName, true));
        reply = { type: "saved", id: message.id };
      } catch (error) {
        reply = {
          type: "save-failed",
          id: message.id,
          message: error instanceof Error ? error.message : String(error),
        };
      }
      connection.sendStateless(JSON.stringify(reply));
    },
    async beforeUnloadDocument({ documentName, document }) {
      if (isClosing) return;
      await serialize(documentName, () => snapshot(documentName, false));
      await persist(documentName, document);
    },
    async afterUnloadDocument({ documentName }) {
      const state = states.get(documentName);
      if (state?.idleTimer) clearTimeout(state.idleTimer);
      states.delete(documentName);
    },
  });

  async function persist(name: string, document?: Y.Doc): Promise<void> {
    const state = states.get(name);
    const doc = document ?? hocuspocus.documents.get(name);
    if (!state || !doc) return;
    await store.put({
      name,
      ...state.target,
      state: Y.encodeStateAsUpdate(doc),
      revision: state.revision,
      schema: state.schema,
    });
  }

  async function load(
    document: Document,
    name: string,
    context: CollabContext,
  ): Promise<void> {
    const target = parseDocumentName(name);
    if (!target || context.userId === undefined) {
      throw denied("collab/invalid-document");
    }
    const head = await ctx.content.head(target.spaceId, target.branch);
    const entry = head && (await ctx.content.getEntry(head.id, target.entryId));
    const body = entry?.body;
    if (!head || !body) throw denied("collab/page-not-found");
    const stored = await store.get(name);
    const schema = context.schema ?? stored?.schema;
    if (!schema) throw denied("collab/no-schema");
    const state: DocumentState = {
      name,
      target,
      revision: head.id,
      schema,
      lastEditor: undefined,
      lastUser: context.userId,
      idleTimer: undefined,
    };
    if (stored) {
      Y.applyUpdate(document, stored.state, SERVER_ORIGIN);
      state.revision = stored.revision;
    } else {
      document.transact(
        () => seedFragment(fragmentOf(document), schema, body),
        SERVER_ORIGIN,
      );
    }
    states.set(name, state);
    if (
      state.revision !== head.id &&
      (await catchUp(state, document)) === "gone"
    ) {
      states.delete(name);
      throw denied("collab/page-not-found");
    }
    // Persisted right away: a restart must find the same Yjs items the
    // clients hold, or their reconnect would duplicate the content.
    await persist(name, document);
  }

  /**
   * Brings a document whose revision is behind the branch head up to it:
   * when the page itself is unchanged, or already reads as the head's, only
   * the revision moves; otherwise the head replaces the shared content.
   */
  async function catchUp(
    state: DocumentState,
    document: Y.Doc,
  ): Promise<"current" | "reset" | "gone"> {
    const { spaceId, branch, entryId } = state.target;
    const head = await ctx.content.head(spaceId, branch);
    if (!head || head.entries[entryId] === undefined) return "gone";
    if (head.id === state.revision) return "current";
    const synced = await ctx.content.getRevision(state.revision);
    const headEntry = await ctx.content.getEntry(head.id, entryId);
    if (!headEntry?.body) return "gone";
    state.revision = head.id;
    if (synced?.entries[entryId] === head.entries[entryId]) return "current";
    const body = headEntry.body;
    const current = bodyOrUndefined(state, document, body);
    if (current && sameTree(current, body)) return "current";
    logger.info(
      "page %s changed on %s outside the shared session; reloading it",
      entryId,
      branch,
    );
    document.transact(() => {
      const fragment = fragmentOf(document);
      fragment.delete(0, fragment.length);
      seedFragment(fragment, state.schema, body);
    }, SERVER_ORIGIN);
    return "reset";
  }

  function bodyOrUndefined(
    state: DocumentState,
    document: Y.Doc,
    synced: Parameters<typeof bodyOfFragment>[2],
  ) {
    try {
      return bodyOfFragment(fragmentOf(document), state.schema, synced);
    } catch (error) {
      logger.warn("shared document %s does not convert: %s", state.name, error);
      return undefined;
    }
  }

  async function close(name: string): Promise<void> {
    hocuspocus.closeConnections(name);
    await store.remove(name);
  }

  async function reconcile(name: string): Promise<void> {
    const state = states.get(name);
    const document = hocuspocus.documents.get(name);
    if (!state || !document || isClosing) return;
    if ((await catchUp(state, document)) === "gone") {
      await close(name);
      return;
    }
    await persist(name, document);
  }

  async function snapshot(name: string, isExplicit: boolean): Promise<void> {
    const state = states.get(name);
    const document = hocuspocus.documents.get(name);
    if (!state || !document || isClosing) return;
    if (state.idleTimer) clearTimeout(state.idleTimer);
    state.idleTimer = undefined;
    const caughtUp = await catchUp(state, document);
    if (caughtUp === "gone") {
      await close(name);
      return;
    }
    // A foreign change replaced the content; there is nothing of ours to commit.
    if (caughtUp === "reset") {
      await persist(name, document);
      return;
    }
    const { spaceId, branch, entryId } = state.target;
    const head = await ctx.content.getRevision(state.revision);
    const entry = head && (await ctx.content.getEntry(head.id, entryId));
    if (!head || !entry?.body) return;
    const body = bodyOrUndefined(state, document, entry.body);
    if (!body || sameTree(body, entry.body)) return;
    await persist(name, document);
    const author = state.lastEditor ?? state.lastUser;
    try {
      const revision = await ctx.content.commit({
        spaceId,
        branch,
        parent: head.id,
        put: { [entryId]: { ...contentOf(entry), body } },
        message: editMessage(entry),
        author,
      });
      state.revision = revision.id;
      state.lastEditor = undefined;
    } catch (error) {
      if (!(error instanceof DocleusError)) throw error;
      if (error.code.endsWith("/stale-head")) {
        await reconcile(name);
      } else {
        logger.warn(
          "could not commit page %s on %s: %s",
          entryId,
          branch,
          error.message,
        );
      }
      if (isExplicit) throw error;
      return;
    }
    await persist(name, document);
  }

  function scheduleSnapshot(state: DocumentState): void {
    if (state.idleTimer) clearTimeout(state.idleTimer);
    state.idleTimer = setTimeout(() => {
      state.idleTimer = undefined;
      serialize(state.name, () => snapshot(state.name, false)).catch(
        (error: unknown) =>
          logger.warn("snapshot of %s failed: %s", state.name, error),
      );
    }, options.idleDelay);
  }

  ctx.on("content/log-appended", (entry: LogEntry) => {
    const committed = committedOf(entry);
    if (!committed) return;
    for (const state of states.values()) {
      const { spaceId, branch, entryId } = state.target;
      if (
        committed.spaceId === spaceId &&
        committed.branch === branch &&
        committed.touched.includes(entryId)
      ) {
        serialize(state.name, () => reconcile(state.name)).catch(
          (error: unknown) =>
            logger.warn("reconcile of %s failed: %s", state.name, error),
        );
      }
    }
  });

  ctx.on("content/flush", async ({ spaceId, branch }) => {
    const names = [...states.values()]
      .filter(
        (state) =>
          state.target.spaceId === spaceId && state.target.branch === branch,
      )
      .map((state) => state.name);
    await Promise.all(
      names.map((name) => serialize(name, () => snapshot(name, false))),
    );
  });

  const adapter = crossws({
    hooks: {
      upgrade(request) {
        const pending = pendingUpgrades.get(request);
        if (!pending) return new Response("Forbidden", { status: 403 });
        return { context: { userId: pending.userId } };
      },
      open(peer) {
        const { websocket } = peer;
        const userId = peer.context.userId;
        if (!isWebSocketLike(websocket) || typeof userId !== "string") {
          peer.close(1011, "unsupported connection");
          return;
        }
        connections.set(
          peer,
          hocuspocus.handleConnection(websocket, peer.request, { userId }),
        );
      },
      message(peer, message) {
        connections.get(peer)?.handleMessage(message.uint8Array());
      },
      close(peer, event) {
        connections.get(peer)?.handleClose({
          code: event.code ?? 1000,
          reason: event.reason ?? "",
        });
      },
      pong(peer) {
        connections.get(peer)?.touch();
      },
      error(_peer, error) {
        logger.warn("collaboration socket error: %s", error);
      },
    },
  });

  ctx.http.upgrade(COLLAB_PATH, async (upgrade) => {
    const { request, actor, incoming, socket, head } = upgrade;
    if (
      actor.kind !== "user" ||
      !(incoming instanceof IncomingMessage) ||
      !(socket instanceof Duplex) ||
      !Buffer.isBuffer(head)
    ) {
      throw new DocleusError(
        "collab/invalid-upgrade",
        "the upgrade is not a signed-in Node WebSocket request",
      );
    }
    pendingUpgrades.set(request, { userId: actor.userId });
    await adapter.handleUpgrade(incoming, socket, head, request);
  });

  ctx.effect(
    () => async () => {
      isClosing = true;
      for (const state of states.values()) {
        if (state.idleTimer) clearTimeout(state.idleTimer);
        state.idleTimer = undefined;
      }
      // The latest state goes to storage; the next start commits it.
      await Promise.all([...states.keys()].map((name) => persist(name)));
      hocuspocus.closeConnections();
      adapter.closeAll(1001, "server shutting down");
      await adapter.close();
      for (const document of hocuspocus.documents.values()) document.destroy();
      hocuspocus.documents.clear();
      states.clear();
    },
    "collaboration server",
  );
}
