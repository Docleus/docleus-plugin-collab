import {
  DocleusError,
  PAGE_ENTRY_TYPE,
  type Context,
  type Entry,
  type EntryContent,
  type Revision,
  type Space,
} from "@docleus/sdk";
import { PLUGIN_NAME, type CollabTarget } from "../shared/index.ts";

export type CollabAccess =
  | {
      readonly isAllowed: true;
      readonly space: Space;
      readonly head: Revision;
      readonly entry: Entry;
    }
  | { readonly isAllowed: false; readonly reason: string };

export function contentOf(entry: Entry): EntryContent {
  const { id: _id, ...content } = entry;
  return content;
}

export function editMessage(entry: Entry): string {
  return `Edit page "${entry.title}"`;
}

async function findSpace(
  ctx: Context,
  spaceId: string,
  orgId: string | undefined,
): Promise<Space | undefined> {
  const orgIds =
    orgId === undefined
      ? (await ctx.content.listOrgs()).map((org) => org.id)
      : [orgId];
  for (const id of orgIds) {
    const space = (await ctx.content.listSpaces(id)).find(
      (candidate) => candidate.id === spaceId,
    );
    if (space) return space;
  }
  return undefined;
}

const denied = (reason: string): CollabAccess => ({ isAllowed: false, reason });

/**
 * Whether `userId` may edit the page together with others: they can write
 * to the space, the plugin is enabled there, and a commit by them to the
 * branch would be accepted. A branch that only takes changes through change
 * requests refuses, so the page is edited alone until an edit branch exists.
 */
export async function authorizeCollab(
  ctx: Context,
  userId: string,
  target: CollabTarget & { readonly orgId?: string },
): Promise<CollabAccess> {
  const space = await findSpace(ctx, target.spaceId, target.orgId);
  if (!space) return denied("collab/space-not-found");
  const scope = {
    kind: "space",
    orgId: space.orgId,
    spaceId: space.id,
  } as const;
  if (!(await ctx.authz.can({ kind: "user", userId }, "write", scope))) {
    return denied("collab/forbidden");
  }
  if (!(await ctx.installations.isEnabled(PLUGIN_NAME, scope))) {
    return denied("collab/not-enabled");
  }
  const branch = await ctx.content.getBranch(space.id, target.branch);
  if (branch?.head === undefined) return denied("collab/branch-not-found");
  const head = await ctx.content.getRevision(branch.head);
  const entry = head && (await ctx.content.getEntry(head.id, target.entryId));
  if (!head || entry?.type !== PAGE_ENTRY_TYPE) {
    return denied("collab/page-not-found");
  }
  try {
    await ctx.content.checkCommit({
      spaceId: space.id,
      branch: target.branch,
      parent: head.id,
      put: { [entry.id]: contentOf(entry) },
      message: editMessage(entry),
      author: userId,
    });
  } catch (error) {
    if (error instanceof DocleusError) return denied(error.code);
    throw error;
  }
  return { isAllowed: true, space, head, entry };
}
