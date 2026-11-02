import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HocuspocusProvider,
  HocuspocusProviderWebsocket,
} from "@hocuspocus/provider";
import {
  PAGE_ENTRY_TYPE,
  type BlockNode,
  type Context,
  type EntryContent,
  type Scope,
  type SpaceRole,
} from "@docleus/sdk";
import { onTestFinished } from "vitest";
import * as Y from "yjs";
import {
  COLLAB_PATH,
  PLUGIN_NAME,
  documentNameOf,
  parseCollabMessage,
  type CollabMessage,
  type CollabTarget,
} from "../src/shared/index.ts";
import { createCollabPlugin } from "../src/server/index.ts";
import { createEditorSchema, describeSchema } from "./editor-schema.ts";

export interface Instance {
  readonly ctx: Context;
  fetch(request: Request): Promise<Response>;
  dispose(): Promise<void>;
}

interface Listening {
  readonly url: string;
  close(): Promise<void>;
}

interface ServerModule {
  createInstance(options: { database?: string }): Promise<Instance>;
  listen(
    instance: Instance,
    options: { port?: number; hostname?: string },
  ): Promise<Listening>;
}

interface TestingModule {
  testStorageLocation(): Promise<string | undefined>;
}

// A literal specifier would pull core's sources into this package's
// typecheck, which uses the DOM lib for the editor entry.
const SERVER_MODULE: string = "@docleus/server";
const TESTING_MODULE: string = "@docleus/testing";

export const createId = () => randomUUID().replaceAll("-", "");

export const SCHEMA = createEditorSchema();
export const SCHEMA_DESCRIPTION = describeSchema(SCHEMA);

export function paragraph(text: string, id = createId()): BlockNode {
  return {
    id,
    type: "paragraph",
    v: 1,
    attrs: {},
    ...(text !== "" && { inline: [{ type: "text", text }] }),
  };
}

export function page(title: string, texts: readonly string[]): EntryContent {
  return {
    type: PAGE_ENTRY_TYPE,
    title,
    parent: undefined,
    order: 0,
    fields: {},
    body: {
      id: createId(),
      type: "doc",
      v: 1,
      attrs: {},
      content: texts.map((text) => paragraph(text)),
    },
  };
}

/** The plain text of each top-level block of a page body. */
export function textsOf(body: BlockNode | undefined): string[] {
  return (body?.content ?? []).map((block) =>
    (block.inline ?? []).map((node) => node.text ?? "").join(""),
  );
}

export interface User {
  readonly id: string;
  readonly token: string;
}

export interface Server {
  readonly instance: Instance;
  readonly url: string;
  /** Stops the server and the instance, keeping the database. */
  stop(): Promise<void>;
}

export interface Fixture {
  readonly orgId: string;
  readonly spaceId: string;
  readonly alice: User;
  readonly bob: User;
  readonly vera: User;
  /** The running server; replaced by {@link Fixture.restart}. */
  server: Server;
  /**
   * Stops the server and starts it again on the same port, running
   * `whileDown` in between; clients reconnect on their own.
   */
  restart(whileDown?: () => void | Promise<void>): Promise<void>;
  /** Creates a page on `branch` with one paragraph per text and returns its id. */
  createPage(texts: readonly string[], branch?: string): Promise<string>;
  body(entryId: string, branch?: string): Promise<BlockNode | undefined>;
  connect(user: User, target: CollabTarget): Promise<Client>;
}

/** A Node WebSocket that signs in with a bearer token. */
function socketFor(token: string): typeof WebSocket {
  return class extends WebSocket {
    constructor(url: string | URL) {
      // Undici's WebSocket takes headers in its init, unlike the browser's.
      super(url, {
        headers: { authorization: `Bearer ${token}` },
      } as unknown as string[]);
    }
  };
}

export interface Client {
  readonly document: Y.Doc;
  readonly provider: HocuspocusProvider;
  readonly fragment: Y.XmlFragment;
  /** Resolves once the server accepted the document, or rejects with its reason. */
  readonly ready: Promise<void>;
  /** Appends a paragraph with `text`, as an editor would. */
  append(text: string): void;
  /** Inserts `text` at the start of the paragraph at `index`. */
  prepend(index: number, text: string): void;
  texts(): string[];
  /** Asks the server to commit now; resolves with its answer. */
  save(): Promise<CollabMessage>;
  dispose(): void;
}

function connectClient(url: string, user: User, target: CollabTarget): Client {
  const document = new Y.Doc();
  const fragment = document.getXmlFragment("default");
  let settle: { resolve(): void; reject(error: Error): void } | undefined;
  const ready = new Promise<void>((resolve, reject) => {
    settle = { resolve, reject };
  });
  const replies = new Map<string, (message: CollabMessage) => void>();
  const websocketProvider = new HocuspocusProviderWebsocket({
    url: `${url.replace(/^http/, "ws")}${COLLAB_PATH}`,
    WebSocketPolyfill: socketFor(user.token),
    // Reconnects quickly after a restart, without the default backoff.
    delay: 50,
    minDelay: 50,
    factor: 1.5,
    maxDelay: 500,
    jitter: false,
  });
  const provider = new HocuspocusProvider({
    websocketProvider,
    name: documentNameOf(target),
    document,
    token: JSON.stringify(SCHEMA_DESCRIPTION),
    onSynced: () => settle?.resolve(),
    onAuthenticationFailed: ({ reason }) => settle?.reject(new Error(reason)),
    onStateless: ({ payload }) => {
      const message = parseCollabMessage(payload);
      if (message) replies.get(message.id)?.(message);
    },
  });
  provider.attach();
  return {
    document,
    provider,
    fragment,
    ready,
    append(text) {
      const element = new Y.XmlElement("paragraph");
      element.setAttribute("blockId", createId());
      element.setAttribute("blockVersion", 1 as unknown as string);
      element.insert(0, [new Y.XmlText(text)]);
      fragment.push([element]);
    },
    prepend(index, text) {
      const element = fragment.get(index);
      if (!(element instanceof Y.XmlElement)) throw new Error("no paragraph");
      const first = element.get(0);
      if (first instanceof Y.XmlText) first.insert(0, text);
      else element.insert(0, [new Y.XmlText(text)]);
    },
    texts() {
      return fragment.toArray().map((node) =>
        node instanceof Y.XmlElement
          ? node
              .toArray()
              .map((child) =>
                child instanceof Y.XmlText ? child.toString() : "",
              )
              .join("")
          : "",
      );
    },
    save() {
      const id = createId();
      return new Promise((resolve) => {
        replies.set(id, resolve);
        provider.sendStateless(JSON.stringify({ type: "save", id }));
      });
    },
    dispose() {
      provider.destroy();
      websocketProvider.destroy();
      document.destroy();
    },
  };
}

/** Polls `check` until it stops throwing, for at most `timeout` ms. */
export async function eventually(
  check: () => void | Promise<void>,
  timeout = 5_000,
): Promise<void> {
  const start = Date.now();
  for (;;) {
    try {
      await check();
      return;
    } catch (error) {
      if (Date.now() - start > timeout) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

/** Waits until the client has no edits the server did not confirm. */
export function settled(client: Client): Promise<void> {
  return eventually(() => {
    if (client.provider.unsyncedChanges > 0) {
      throw new Error(`${client.provider.unsyncedChanges} unsynced changes`);
    }
  });
}

/**
 * A real instance with the plugin, served over HTTP on a free port, with a
 * database that survives {@link Fixture.restart}. Alice and Bob edit the
 * space, Vera reads it.
 */
export async function setUp(options: { idleDelay?: number } = {}) {
  const server = (await import(SERVER_MODULE)) as ServerModule;
  const testing = (await import(TESTING_MODULE)) as TestingModule;
  const dir = mkdtempSync(join(tmpdir(), "docleus-collab-"));
  const database =
    (await testing.testStorageLocation()) ?? join(dir, "docleus.db");
  const clients = new Set<Client>();

  async function start(port = 0): Promise<Server> {
    const instance = await server.createInstance({ database });
    await instance.ctx.plugin(
      createCollabPlugin({ idleDelay: options.idleDelay ?? 60_000 }),
    );
    const listening = await server.listen(instance, { port });
    return {
      instance,
      url: listening.url,
      async stop() {
        await listening.close();
        await instance.dispose();
      },
    };
  }

  const first = await start();
  const { ctx } = first.instance;
  await ctx.installations.install(PLUGIN_NAME);
  const org = await ctx.content.createOrg({ slug: "acme", name: "Acme" });
  const orgScope: Scope = { kind: "org", orgId: org.id };
  await ctx.installations.setEnabled(PLUGIN_NAME, orgScope, true);
  const space = await ctx.content.createSpace({
    orgId: org.id,
    slug: "docs",
    name: "Docs",
  });
  const spaceScope: Scope = {
    kind: "space",
    orgId: org.id,
    spaceId: space.id,
  };

  async function createUser(name: string, role: SpaceRole): Promise<User> {
    const user = await ctx.identity.createUser({
      email: `${name.toLowerCase()}@example.com`,
      name,
    });
    await ctx.authz.grant(user.id, spaceScope, role);
    return { id: user.id, token: await ctx.identity.createSession(user.id) };
  }

  const fixture: Fixture = {
    orgId: org.id,
    spaceId: space.id,
    alice: await createUser("Alice", "editor"),
    bob: await createUser("Bob", "editor"),
    vera: await createUser("Vera", "viewer"),
    server: first,
    async restart(whileDown) {
      const port = new URL(fixture.server.url).port;
      await fixture.server.stop();
      await whileDown?.();
      fixture.server = await start(Number(port));
    },
    async createPage(texts, branch) {
      const content = fixture.server.instance.ctx.content;
      const id = createId();
      const head = await content.head(space.id, branch);
      await content.commit({
        spaceId: space.id,
        ...(branch !== undefined && { branch }),
        parent: head?.id,
        put: { [id]: page("Guide", texts) },
        message: "Seed",
      });
      return id;
    },
    async body(entryId, branch) {
      const content = fixture.server.instance.ctx.content;
      const head = await content.head(space.id, branch);
      return head && (await content.getEntry(head.id, entryId))?.body;
    },
    async connect(user, target) {
      const client = connectClient(fixture.server.url, user, target);
      clients.add(client);
      return client;
    },
  };

  onTestFinished(async () => {
    for (const client of clients) client.dispose();
    await fixture.server.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  return fixture;
}
