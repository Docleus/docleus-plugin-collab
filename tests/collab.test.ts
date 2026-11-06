import { DocleusError, MAIN_BRANCH, type PreCommitInput } from "@docleus/sdk";
import type { Kysely } from "kysely";
import { describe, expect, it } from "vitest";
import { PLUGIN_NAME, collabStatusPath } from "../src/shared/index.ts";
import {
  eventually,
  settled,
  setUp,
  textsOf,
  type Fixture,
} from "./helpers.ts";

const target = (f: Fixture, entryId: string, branch = MAIN_BRANCH) => ({
  spaceId: f.spaceId,
  branch,
  entryId,
});

async function headOf(f: Fixture, branch = MAIN_BRANCH) {
  return f.server.instance.ctx.content.head(f.spaceId, branch);
}

describe("shared editing", () => {
  it("lets two clients edit one page and see each other's changes", async () => {
    const f = await setUp();
    const entryId = await f.createPage(["Hello"]);
    const alice = await f.connect(f.alice, target(f, entryId));
    const bob = await f.connect(f.bob, target(f, entryId));
    await Promise.all([alice.ready, bob.ready]);
    expect(alice.texts()).toEqual(["Hello"]);
    expect(bob.texts()).toEqual(["Hello"]);

    alice.append("From Alice");
    bob.prepend(0, "Bob: ");
    await eventually(() => {
      expect(alice.texts()).toEqual(["Bob: Hello", "From Alice"]);
      expect(bob.texts()).toEqual(alice.texts());
    });
  });

  it("shares presence through awareness", async () => {
    const f = await setUp();
    const entryId = await f.createPage(["Hello"]);
    const alice = await f.connect(f.alice, target(f, entryId));
    const bob = await f.connect(f.bob, target(f, entryId));
    await Promise.all([alice.ready, bob.ready]);
    alice.provider.setAwarenessField("user", { name: "Alice" });
    await eventually(() => {
      const users = [...(bob.provider.awareness?.getStates().values() ?? [])];
      expect(users).toContainEqual({ user: { name: "Alice" } });
    });
  });

  it("commits on an explicit save, authored by the last editor", async () => {
    const f = await setUp();
    const entryId = await f.createPage(["Hello"]);
    const before = await headOf(f);
    const alice = await f.connect(f.alice, target(f, entryId));
    const bob = await f.connect(f.bob, target(f, entryId));
    await Promise.all([alice.ready, bob.ready]);

    bob.append("World");
    await settled(bob);
    expect(await alice.save()).toMatchObject({ type: "saved" });

    const head = await headOf(f);
    expect(head?.id).not.toBe(before?.id);
    expect(head?.author).toBe(f.bob.id);
    expect(textsOf(await f.body(entryId))).toEqual(["Hello", "World"]);
  });

  it("keeps untouched blocks as stored", async () => {
    const f = await setUp();
    const entryId = await f.createPage(["One", "Two"]);
    const stored = await f.body(entryId);
    const alice = await f.connect(f.alice, target(f, entryId));
    await alice.ready;
    alice.prepend(1, "Second: ");
    await settled(alice);
    await alice.save();

    const body = await f.body(entryId);
    expect(body?.id).toBe(stored?.id);
    expect(body?.content?.[0]).toEqual(stored?.content?.[0]);
    expect(body?.content?.[1]?.id).toBe(stored?.content?.[1]?.id);
    expect(textsOf(body)).toEqual(["One", "Second: Two"]);
  });

  it("does not commit when nothing changed", async () => {
    const f = await setUp();
    const entryId = await f.createPage(["Hello"]);
    const before = await headOf(f);
    const alice = await f.connect(f.alice, target(f, entryId));
    await alice.ready;
    expect(await alice.save()).toMatchObject({ type: "saved" });
    expect((await headOf(f))?.id).toBe(before?.id);
  });

  it("commits after the idle delay", async () => {
    const f = await setUp({ idleDelay: 100 });
    const entryId = await f.createPage(["Hello"]);
    const alice = await f.connect(f.alice, target(f, entryId));
    await alice.ready;
    alice.append("Idle");
    await eventually(async () => {
      expect(textsOf(await f.body(entryId))).toEqual(["Hello", "Idle"]);
    });
  });

  it("commits when the last client leaves", async () => {
    const f = await setUp();
    const entryId = await f.createPage(["Hello"]);
    const alice = await f.connect(f.alice, target(f, entryId));
    await alice.ready;
    alice.append("Leaving");
    await settled(alice);
    alice.dispose();
    await eventually(async () => {
      expect(textsOf(await f.body(entryId))).toEqual(["Hello", "Leaving"]);
    });
  });

  it("commits on content/flush for the branch", async () => {
    const f = await setUp();
    const entryId = await f.createPage(["Hello"]);
    const alice = await f.connect(f.alice, target(f, entryId));
    await alice.ready;
    alice.append("Flushed");
    await settled(alice);

    const { ctx } = f.server.instance;
    const scope = await ctx.installations.scope({
      kind: "space",
      orgId: f.orgId,
      spaceId: f.spaceId,
    });
    await ctx.parallel(scope, "content/flush", {
      spaceId: f.spaceId,
      branch: MAIN_BRANCH,
    });
    expect(textsOf(await f.body(entryId))).toEqual(["Hello", "Flushed"]);
  });

  it("reloads the page when someone else commits it", async () => {
    const f = await setUp();
    const entryId = await f.createPage(["Hello"]);
    const alice = await f.connect(f.alice, target(f, entryId));
    await alice.ready;

    const { content } = f.server.instance.ctx;
    const head = await content.head(f.spaceId);
    const entry = head && (await content.getEntry(head.id, entryId));
    if (!head || !entry?.body) throw new Error("no page");
    const { id: _id, ...rest } = entry;
    await content.commit({
      spaceId: f.spaceId,
      parent: head.id,
      put: {
        [entryId]: {
          ...rest,
          body: {
            ...entry.body,
            content: [
              {
                id: "replaced",
                type: "paragraph",
                v: 1,
                attrs: {},
                inline: [{ type: "text", text: "Replaced" }],
              },
            ],
          },
        },
      },
      message: "Import",
      author: f.bob.id,
    });
    await eventually(() => expect(alice.texts()).toEqual(["Replaced"]));
  });

  it("loses nothing across a restart", async () => {
    const f = await setUp();
    const entryId = await f.createPage(["Hello"]);
    const alice = await f.connect(f.alice, target(f, entryId));
    const bob = await f.connect(f.bob, target(f, entryId));
    await Promise.all([alice.ready, bob.ready]);
    alice.append("Before");
    await settled(alice);

    await f.restart(() => {
      bob.append("While down");
    });
    alice.append("After");
    // The two appends are concurrent, so Yjs orders them by client id.
    const expected = ["After", "Before", "Hello", "While down"];
    await eventually(() => {
      expect(alice.texts().toSorted()).toEqual(expected);
      expect(bob.texts()).toEqual(alice.texts());
    });
    await settled(alice);
    await settled(bob);
    expect(await alice.save()).toMatchObject({ type: "saved" });
    expect(textsOf(await f.body(entryId))).toEqual(alice.texts());
  });
});

describe("access", () => {
  it.each([
    ["grant revocation", "collab/forbidden"],
    ["editor demotion", "collab/forbidden"],
    ["user removal", "collab/forbidden"],
    ["plugin disablement", "collab/not-enabled"],
    ["branch policy change", "test/commit-rejected"],
  ] as const)("rechecks connected clients after %s", async (change, reason) => {
    const f = await setUp();
    const entryId = await f.createPage(["Hello"]);
    const alice = await f.connect(f.alice, target(f, entryId));
    const bob = await f.connect(f.bob, target(f, entryId));
    await Promise.all([alice.ready, bob.ready]);
    await alice.save();
    const { ctx } = f.server.instance;
    const scope = {
      kind: "space",
      orgId: f.orgId,
      spaceId: f.spaceId,
    } as const;
    if (change === "grant revocation") {
      await ctx.authz.revoke(f.alice.id, scope);
    } else if (change === "editor demotion") {
      await ctx.authz.grant(f.alice.id, scope, "viewer");
    } else if (change === "user removal") {
      await ctx.identity.logoutAll(f.alice.id);
      const db = ctx.storage.db as unknown as Kysely<{
        users: { id: string };
      }>;
      await db.deleteFrom("users").where("id", "=", f.alice.id).execute();
    } else if (change === "plugin disablement") {
      await ctx.installations.setEnabled(PLUGIN_NAME, scope, false);
    } else {
      ctx.on(
        "content/pre-commit",
        async (input: PreCommitInput, next: () => Promise<PreCommitInput>) => {
          if (input.commit.author === f.alice.id) {
            throw new DocleusError("test/commit-rejected", "use a branch");
          }
          return next();
        },
      );
    }

    const closed = new Promise<{ type: "closed"; reason: string }>(
      (resolve) => {
        alice.provider.configuration.onClose = ({ event }) =>
          resolve({ type: "closed", reason: event.reason });
      },
    );
    alice.append("Unauthorized");
    alice.provider.flushPendingUpdates();
    const response = await Promise.race([closed, alice.save()]);
    expect(bob.texts()).toEqual(["Hello"]);
    expect(response).toEqual({ type: "closed", reason });

    if (change === "plugin disablement") {
      await ctx.installations.setEnabled(PLUGIN_NAME, scope, true);
    }
    bob.append("Still authorized");
    await settled(bob);
    expect(await bob.save()).toMatchObject({ type: "saved" });
    expect(textsOf(await f.body(entryId))).toEqual([
      "Hello",
      "Still authorized",
    ]);
  });

  it("refuses a save from a revoked connection without a new update", async () => {
    const f = await setUp();
    const entryId = await f.createPage(["Hello"]);
    const alice = await f.connect(f.alice, target(f, entryId));
    await alice.ready;
    await alice.save();
    await f.server.instance.ctx.authz.revoke(f.alice.id, {
      kind: "space",
      orgId: f.orgId,
      spaceId: f.spaceId,
    });
    const closed = new Promise<{ type: "closed"; reason: string }>(
      (resolve) => {
        alice.provider.configuration.onClose = ({ event }) =>
          resolve({ type: "closed", reason: event.reason });
      },
    );
    expect(await Promise.race([closed, alice.save()])).toEqual({
      type: "closed",
      reason: "collab/forbidden",
    });
    expect(textsOf(await f.body(entryId))).toEqual(["Hello"]);
  });

  it.each(["grant revocation", "plugin disablement"] as const)(
    "rechecks a pending snapshot after %s without losing accepted edits",
    async (change) => {
      const f = await setUp();
      const entryId = await f.createPage(["Hello"]);
      const alice = await f.connect(f.alice, target(f, entryId));
      const bob = await f.connect(f.bob, target(f, entryId));
      await Promise.all([alice.ready, bob.ready]);
      alice.append("Accepted before access changed");
      await settled(alice);
      const { ctx } = f.server.instance;
      const scope = {
        kind: "space",
        orgId: f.orgId,
        spaceId: f.spaceId,
      } as const;
      const flushScope = await ctx.installations.scope(scope);
      if (change === "grant revocation") {
        await ctx.authz.revoke(f.alice.id, scope);
        expect(await bob.save()).toMatchObject({ type: "save-failed" });
      } else {
        await ctx.installations.setEnabled(PLUGIN_NAME, scope, false);
      }
      await ctx.parallel(flushScope, "content/flush", {
        spaceId: f.spaceId,
        branch: MAIN_BRANCH,
      });
      expect(textsOf(await f.body(entryId))).toEqual(["Hello"]);

      await ctx.authz.grant(f.alice.id, scope, "editor");
      await ctx.installations.setEnabled(PLUGIN_NAME, scope, true);
      expect(await bob.save()).toMatchObject({ type: "saved" });
      expect(textsOf(await f.body(entryId))).toEqual([
        "Hello",
        "Accepted before access changed",
      ]);
      expect((await headOf(f))?.author).toBe(f.alice.id);
    },
  );

  it("answers whether a page can be shared", async () => {
    const f = await setUp();
    const entryId = await f.createPage(["Hello"]);
    const status = async (token: string) => {
      const response = await fetch(
        new URL(
          collabStatusPath(f.orgId, f.spaceId, entryId, MAIN_BRANCH),
          f.server.url,
        ),
        { headers: { authorization: `Bearer ${token}` } },
      );
      return response.json();
    };
    expect(await status(f.alice.token)).toEqual({
      canShare: true,
      user: { name: "Alice", color: expect.stringMatching(/^#/) },
    });
    expect(await status(f.vera.token)).toEqual({
      canShare: false,
      reason: "collab/forbidden",
    });
  });

  it("refuses readers", async () => {
    const f = await setUp();
    const entryId = await f.createPage(["Hello"]);
    const vera = await f.connect(f.vera, target(f, entryId));
    await expect(vera.ready).rejects.toThrow("collab/forbidden");
  });

  it("refuses a branch that rejects the user's commits", async () => {
    const f = await setUp();
    const entryId = await f.createPage(["Hello"]);
    f.server.instance.ctx.on(
      "content/pre-commit",
      async (input: PreCommitInput, next: () => Promise<PreCommitInput>) => {
        if (input.commit.author !== undefined) {
          throw new DocleusError("test/commit-rejected", "use a branch");
        }
        return next();
      },
    );
    const alice = await f.connect(f.alice, target(f, entryId));
    await expect(alice.ready).rejects.toThrow("test/commit-rejected");
  });

  it("refuses spaces where the plugin is disabled", async () => {
    const f = await setUp();
    const entryId = await f.createPage(["Hello"]);
    await f.server.instance.ctx.installations.setEnabled(
      PLUGIN_NAME,
      { kind: "space", orgId: f.orgId, spaceId: f.spaceId },
      false,
    );
    const alice = await f.connect(f.alice, target(f, entryId));
    await expect(alice.ready).rejects.toThrow("collab/not-enabled");
  });

  it("refuses pages that do not exist", async () => {
    const f = await setUp();
    await f.createPage(["Hello"]);
    const alice = await f.connect(f.alice, target(f, "missing"));
    await expect(alice.ready).rejects.toThrow("collab/page-not-found");
  });
});
