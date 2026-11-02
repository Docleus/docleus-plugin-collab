import { createHash } from "node:crypto";
import { MAIN_BRANCH, type Context } from "@docleus/sdk";
import type { CollabStatus } from "../shared/index.ts";
import { authorizeCollab } from "./auth.ts";

/** Caret colors, readable on a light page with dark text on top. */
const CARET_COLORS = [
  "#f59e0b",
  "#10b981",
  "#3b82f6",
  "#ec4899",
  "#8b5cf6",
  "#ef4444",
  "#14b8a6",
  "#f97316",
];

/** The same color for a user in every session and on every page. */
export function colorOf(userId: string): string {
  const digest = createHash("sha256").update(userId).digest();
  return CARET_COLORS[(digest[0] ?? 0) % CARET_COLORS.length] ?? "#3b82f6";
}

function answer(status: CollabStatus): Response {
  return Response.json(status);
}

export function registerRoutes(ctx: Context): void {
  ctx.http.route(
    "GET",
    "/api/orgs/:orgId/spaces/:spaceId/pages/:pageId/collab",
    async ({ request, params, actor }) => {
      const { orgId, spaceId, pageId } = params;
      if (
        orgId === undefined ||
        spaceId === undefined ||
        pageId === undefined
      ) {
        return answer({ canShare: false, reason: "collab/invalid-request" });
      }
      if (actor.kind !== "user") {
        return answer({ canShare: false, reason: "collab/forbidden" });
      }
      const branch =
        new URL(request.url).searchParams.get("branch") ?? MAIN_BRANCH;
      const access = await authorizeCollab(ctx, actor.userId, {
        orgId,
        spaceId,
        branch,
        entryId: pageId,
      });
      if (!access.isAllowed) {
        return answer({ canShare: false, reason: access.reason });
      }
      const user = await ctx.identity.getUser(actor.userId);
      return answer({
        canShare: true,
        user: {
          name: user?.name ?? actor.userId,
          color: colorOf(actor.userId),
        },
      });
    },
  );
}
