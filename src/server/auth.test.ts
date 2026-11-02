import {
  DocleusError,
  type CommitInput,
  type Context,
  type Entry,
  type Revision,
  type Space,
} from "@docleus/sdk";
import { describe, expect, it } from "vitest";
import { authorizeCollab } from "./auth.ts";

const SPACE: Space = {
  id: "s1",
  orgId: "o1",
  slug: "docs",
  name: "Docs",
} as Space;

const PAGE: Entry = {
  id: "e1",
  type: "page",
  title: "Guide",
  parent: undefined,
  order: 0,
  fields: {},
};

const HEAD: Revision = {
  id: "r1",
  spaceId: "s1",
  branch: "cr/1",
  parent: undefined,
  entries: { e1: "hash" },
  message: "Seed",
  author: undefined,
  merged: undefined,
  at: 0,
};

interface World {
  canWrite?: boolean;
  isEnabled?: boolean;
  entry?: Entry;
  rejectCommit?: string;
}

function fakeContext(world: World, commits: CommitInput[] = []): Context {
  const ctx = {
    authz: { can: async () => world.canWrite ?? true },
    installations: { isEnabled: async () => world.isEnabled ?? true },
    content: {
      listOrgs: async () => [{ id: "o1" }],
      listSpaces: async (orgId: string) => (orgId === "o1" ? [SPACE] : []),
      getBranch: async (_spaceId: string, name: string) =>
        name === "cr/1" ? { spaceId: "s1", name, head: "r1" } : undefined,
      getRevision: async (id: string) => (id === "r1" ? HEAD : undefined),
      getEntry: async (_revision: string, id: string) =>
        id === "e1" ? (world.entry ?? PAGE) : undefined,
      checkCommit: async (input: CommitInput) => {
        commits.push(input);
        if (world.rejectCommit !== undefined) {
          throw new DocleusError(world.rejectCommit, "rejected");
        }
      },
    },
  };
  return ctx as unknown as Context;
}

const target = { spaceId: "s1", branch: "cr/1", entryId: "e1" };

describe("authorizeCollab", () => {
  it("allows a writer, checking a commit by them to the branch", async () => {
    const commits: CommitInput[] = [];
    const access = await authorizeCollab(
      fakeContext({}, commits),
      "u1",
      target,
    );
    expect(access).toMatchObject({ isAllowed: true, head: HEAD, entry: PAGE });
    expect(commits).toEqual([
      expect.objectContaining({
        spaceId: "s1",
        branch: "cr/1",
        parent: "r1",
        author: "u1",
      }),
    ]);
  });

  it.each<[string, World, Partial<typeof target> & { orgId?: string }]>([
    ["collab/space-not-found", {}, { spaceId: "s2" }],
    ["collab/space-not-found", {}, { orgId: "o2" }],
    ["collab/forbidden", { canWrite: false }, {}],
    ["collab/not-enabled", { isEnabled: false }, {}],
    ["collab/branch-not-found", {}, { branch: "cr/2" }],
    ["collab/page-not-found", {}, { entryId: "e2" }],
    ["collab/page-not-found", { entry: { ...PAGE, type: "folder" } }, {}],
    [
      "change-requests/commit-rejected",
      { rejectCommit: "change-requests/commit-rejected" },
      {},
    ],
  ])("refuses with %s", async (reason, world, overrides) => {
    expect(
      await authorizeCollab(fakeContext(world), "u1", {
        ...target,
        ...overrides,
      }),
    ).toEqual({ isAllowed: false, reason });
  });
});
