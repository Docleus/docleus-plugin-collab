import { randomBytes } from "node:crypto";
import {
  BLOCK_ID_ATTR,
  BLOCK_VERSION_ATTR,
  fromEditorDocument,
  toEditorDocument,
  type BlockNode,
  type EditorJsonNode,
  type EditorSchemaDescription,
} from "@docleus/sdk";
import type * as Y from "yjs";
import { readFragment, schemaInfoOf, writeFragment } from "./encoding.ts";
import { reuseUnchanged } from "./reuse.ts";

function createBlockId(): string {
  return randomBytes(8).toString("base64url");
}

function isBlockNode(
  node: EditorJsonNode,
  schema: EditorSchemaDescription,
): boolean {
  const attrs = schema.nodes[node.type];
  return attrs !== undefined && BLOCK_ID_ATTR in attrs;
}

/**
 * Gives block nodes without an id, or with an id seen before, a fresh one,
 * and a version when they have none. The editor does so itself; this covers
 * a snapshot taken before it did, and concurrent splits that copied an id.
 */
function withBlockIds(
  node: EditorJsonNode,
  schema: EditorSchemaDescription,
  seen: Set<string>,
): EditorJsonNode {
  const content = node.content?.map((child) =>
    withBlockIds(child, schema, seen),
  );
  if (!isBlockNode(node, schema)) {
    return content ? { ...node, content } : node;
  }
  const attrs = { ...node.attrs };
  const id = attrs[BLOCK_ID_ATTR];
  if (typeof id !== "string" || id === "" || seen.has(id)) {
    attrs[BLOCK_ID_ATTR] = createBlockId();
  }
  seen.add(String(attrs[BLOCK_ID_ATTR]));
  if (typeof attrs[BLOCK_VERSION_ATTR] !== "number") {
    attrs[BLOCK_VERSION_ATTR] = 1;
  }
  return { ...node, attrs, ...(content && { content }) };
}

/**
 * The page body a shared document holds, based on `synced`, the body of the
 * revision it was last synced to: the root keeps that body's id and attrs
 * (the editor never sees them), and untouched blocks keep their stored form.
 */
export function bodyOfFragment(
  fragment: Y.XmlFragment,
  schema: EditorSchemaDescription,
  synced: BlockNode,
): BlockNode {
  const root = toEditorDocument({ ...synced, content: [] });
  const json = readFragment(fragment, schema, root.attrs);
  const seen = new Set<string>([synced.id]);
  const content = (json.content ?? []).map((child) =>
    withBlockIds(child, schema, seen),
  );
  return reuseUnchanged(synced, fromEditorDocument({ ...json, content }));
}

/** Writes `body` into an empty `fragment`, as the editor would show it. */
export function seedFragment(
  fragment: Y.XmlFragment,
  schema: EditorSchemaDescription,
  body: BlockNode,
): void {
  const json = toEditorDocument(body, schemaInfoOf(schema));
  const content = json.content ?? [];
  writeFragment(
    fragment,
    {
      ...json,
      content:
        content.length > 0
          ? content
          : [
              {
                type: "paragraph",
                attrs: {
                  [BLOCK_ID_ATTR]: createBlockId(),
                  [BLOCK_VERSION_ATTR]: 1,
                },
              },
            ],
    },
    schema,
  );
}
