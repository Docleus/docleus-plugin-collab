import { z, type EditorSchemaDescription } from "@docleus/sdk";

export const PLUGIN_NAME = "@docleus/plugin-collab";

/** Where the collaboration WebSocket is served. */
export const COLLAB_PATH = "/api/collab";

/** The `XmlFragment` of the shared document that holds the page body. */
export const COLLAB_FRAGMENT = "default";

/** The page a shared document belongs to. */
export interface CollabTarget {
  readonly spaceId: string;
  readonly branch: string;
  readonly entryId: string;
}

const ID = /^[0-9A-Za-z_-]+$/;

/** The shared document name of a page: `<spaceId>/<branch>/<entryId>`. Branch names may contain `/`. */
export function documentNameOf(target: CollabTarget): string {
  return `${target.spaceId}/${target.branch}/${target.entryId}`;
}

/** The page of a shared document name, or `undefined` when it is malformed. */
export function parseDocumentName(name: string): CollabTarget | undefined {
  const first = name.indexOf("/");
  const last = name.lastIndexOf("/");
  if (first <= 0 || last <= first + 1) return undefined;
  const spaceId = name.slice(0, first);
  const branch = name.slice(first + 1, last);
  const entryId = name.slice(last + 1);
  if (!ID.test(spaceId) || !ID.test(entryId)) return undefined;
  return { spaceId, branch, entryId };
}

/** The route that tells an editor whether a page can be edited together. */
export function collabStatusPath(
  orgId: string,
  spaceId: string,
  pageId: string,
  branch: string,
): string {
  return `/api/orgs/${encodeURIComponent(orgId)}/spaces/${encodeURIComponent(spaceId)}/pages/${encodeURIComponent(pageId)}/collab?branch=${encodeURIComponent(branch)}`;
}

/** How a user appears to the others. */
export interface CollabUser {
  readonly name: string;
  readonly color: string;
}

/** The answer of the collaboration status route. */
export type CollabStatus =
  | { readonly canShare: true; readonly user: CollabUser }
  | { readonly canShare: false; readonly reason: string };

/** Stateless messages between the editor and the server. */
export type CollabMessage =
  | { readonly type: "save"; readonly id: string }
  | { readonly type: "saved"; readonly id: string }
  | {
      readonly type: "save-failed";
      readonly id: string;
      readonly message: string;
    };

const collabMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal(["save", "saved"]), id: z.string() }),
  z.object({
    type: z.literal("save-failed"),
    id: z.string(),
    message: z.string(),
  }),
]);

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function parseCollabMessage(text: string): CollabMessage | undefined {
  return collabMessageSchema.safeParse(parseJson(text)).data;
}

const attrMapSchema = z.record(z.string(), z.record(z.string(), z.unknown()));

const schemaDescriptionSchema = z.object({
  nodes: attrMapSchema,
  marks: attrMapSchema,
  overlappingMarks: z.array(z.string()),
});

/** Validates an editor schema description that came over the wire or from storage. */
export function parseSchemaDescription(
  value: unknown,
): EditorSchemaDescription | undefined {
  return schemaDescriptionSchema.safeParse(value).data;
}
