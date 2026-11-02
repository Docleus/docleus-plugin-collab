import type { EditorCollaborationTarget } from "@docleus/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { CollabStatus } from "../shared/index.ts";
import {
  collabUrlOf,
  createCollabProvider,
  SAVE_TIMEOUT_MS,
  SYNC_TIMEOUT_MS,
  type CollabConnectOptions,
} from "./provider.ts";

const TARGET: EditorCollaborationTarget = {
  orgId: "o1",
  spaceId: "s1",
  branch: "cr/1",
  entryId: "e1",
  schema: { nodes: {}, marks: {}, overlappingMarks: [] },
};

const SHARED: CollabStatus = {
  canShare: true,
  user: { name: "Alice", color: "#3b82f6" },
};

function setUp(status: CollabStatus | Response = SHARED) {
  const requests: string[] = [];
  const sent: string[] = [];
  const connections: CollabConnectOptions[] = [];
  let destroyed = 0;
  const provider = createCollabProvider({
    ui: {
      request: async (path) => {
        requests.push(path);
        return status instanceof Response ? status : Response.json(status);
      },
    },
    url: "ws://docs.test/api/collab",
    connect: (options) => {
      connections.push(options);
      return {
        provider: { awareness: "fake" },
        sendStateless: (payload) => sent.push(payload),
        destroy: () => {
          destroyed += 1;
        },
      };
    },
    createId: () => `save-${String(sent.length + 1)}`,
  });
  const connection = () => {
    const options = connections[0];
    if (!options) throw new Error("not connected");
    return options;
  };
  return {
    provider,
    requests,
    sent,
    connection,
    connections,
    destroyed: () => destroyed,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("collabUrlOf", () => {
  it("follows the page's scheme", () => {
    expect(collabUrlOf({ protocol: "https:", host: "docs.test" })).toBe(
      "wss://docs.test/api/collab",
    );
    expect(collabUrlOf({ protocol: "http:", host: "localhost:4321" })).toBe(
      "ws://localhost:4321/api/collab",
    );
  });
});

describe("createCollabProvider", () => {
  it("asks the status route, then connects the page's document", async () => {
    const world = setUp();
    const session = await world.provider(TARGET);
    expect(world.requests).toEqual([
      "/api/orgs/o1/spaces/s1/pages/e1/collab?branch=cr%2F1",
    ]);
    expect(world.connection()).toMatchObject({
      url: "ws://docs.test/api/collab",
      name: "s1/cr/1/e1",
      token: JSON.stringify(TARGET.schema),
    });
    expect(session).toMatchObject({
      fragment: "default",
      provider: { awareness: "fake" },
      user: SHARED.user,
    });
    expect(session?.document).toBeInstanceOf(Y.Doc);
    expect(session?.document).toBe(world.connection().document);

    world.connection().onSynced();
    await expect(session?.synced).resolves.toBeUndefined();
    session?.dispose();
    expect(world.destroyed()).toBe(1);
  });

  it("leaves a page it cannot share alone", async () => {
    const world = setUp({ canShare: false, reason: "collab/forbidden" });
    expect(await world.provider(TARGET)).toBeUndefined();
    expect(world.connections).toEqual([]);
  });

  it("throws when the status route fails", async () => {
    const world = setUp(new Response("no", { status: 500 }));
    await expect(world.provider(TARGET)).rejects.toMatchObject({
      code: "collab/status-failed",
    });
  });

  it.each([
    { canShare: true },
    { canShare: true, user: { name: "Ada" } },
    { canShare: false },
    { canShare: "yes", reason: "x" },
  ])("throws on a malformed status answer %j", async (status) => {
    const world = setUp(Response.json(status));
    await expect(world.provider(TARGET)).rejects.toMatchObject({
      code: "collab/status-failed",
      message: "the collaboration status answer is malformed",
    });
  });

  it("fails to sync when the server refuses", async () => {
    const world = setUp();
    const session = await world.provider(TARGET);
    world.connection().onAuthenticationFailed("collab/not-enabled");
    await expect(session?.synced).rejects.toMatchObject({
      code: "collab/denied",
      message: expect.stringContaining("collab/not-enabled"),
    });
    session?.dispose();
  });

  it("fails to sync when the server does not answer", async () => {
    vi.useFakeTimers();
    const world = setUp();
    const session = await world.provider(TARGET);
    const synced = expect(session?.synced).rejects.toMatchObject({
      code: "collab/sync-timeout",
    });
    vi.advanceTimersByTime(SYNC_TIMEOUT_MS);
    await synced;
    session?.dispose();
  });

  it("saves through a stateless message and its reply", async () => {
    const world = setUp();
    const session = await world.provider(TARGET);
    world.connection().onSynced();

    const saved = session?.save();
    expect(world.sent).toEqual([
      JSON.stringify({ type: "save", id: "save-1" }),
    ]);
    world
      .connection()
      .onStateless(JSON.stringify({ type: "saved", id: "other" }));
    world
      .connection()
      .onStateless(JSON.stringify({ type: "saved", id: "save-1" }));
    await expect(saved).resolves.toBeUndefined();

    const failed = session?.save();
    world
      .connection()
      .onStateless(
        JSON.stringify({ type: "save-failed", id: "save-2", message: "stale" }),
      );
    await expect(failed).rejects.toMatchObject({
      code: "collab/save-failed",
      message: "stale",
    });
    session?.dispose();
  });

  it("fails a save the server never confirms, or that the editor leaves", async () => {
    vi.useFakeTimers();
    const world = setUp();
    const session = await world.provider(TARGET);
    world.connection().onSynced();

    const timedOut = expect(session?.save()).rejects.toMatchObject({
      code: "collab/save-timeout",
    });
    vi.advanceTimersByTime(SAVE_TIMEOUT_MS);
    await timedOut;

    const closed = expect(session?.save()).rejects.toMatchObject({
      code: "collab/closed",
    });
    session?.dispose();
    await closed;
  });
});
