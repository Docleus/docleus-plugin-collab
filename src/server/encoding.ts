import type {
  EditorJsonMark,
  EditorJsonNode,
  EditorSchemaDescription,
  EditorSchemaInfo,
} from "@docleus/sdk";
import { encodeAny, toBase64 } from "lib0/buffer";
import { digest } from "lib0/hash/sha256";
import * as Y from "yjs";

// The shared document uses y-tiptap's encoding of ProseMirror content, which
// the editor's Collaboration extension reads and writes. The server has no
// ProseMirror schema, so the editor describes its own (attr defaults in
// schema order, and which marks overlap), and this module applies what
// ProseMirror would: defaults filled in, marks in schema order.

type Attrs = Readonly<Record<string, unknown>>;

interface TextDeltaItem {
  readonly insert: string;
  readonly attributes?: Readonly<Record<string, unknown>>;
}

function keys(attrs: Attrs | undefined): Set<string> | undefined {
  return attrs ? new Set(Object.keys(attrs)) : undefined;
}

/** What a schema description can show, for `toEditorDocument`. */
export function schemaInfoOf(
  schema: EditorSchemaDescription,
): EditorSchemaInfo {
  return {
    nodeAttrs: (name) => keys(schema.nodes[name]),
    markAttrs: (name) => keys(schema.marks[name]),
  };
}

function withDefaults(
  defaults: Attrs | undefined,
  attrs: Attrs | undefined,
): Record<string, unknown> {
  if (!defaults) return { ...attrs };
  return Object.fromEntries(
    Object.entries(defaults).map(([key, fallback]) => [
      key,
      attrs?.[key] === undefined ? fallback : attrs[key],
    ]),
  );
}

function markRank(schema: EditorSchemaDescription): (name: string) => number {
  const order = Object.keys(schema.marks);
  return (name) => {
    const index = order.indexOf(name);
    return index === -1 ? order.length : index;
  };
}

function normalizeMarks(
  marks: readonly EditorJsonMark[],
  schema: EditorSchemaDescription,
): EditorJsonMark[] {
  const rank = markRank(schema);
  return marks
    .map((mark) => {
      const attrs = withDefaults(schema.marks[mark.type], mark.attrs);
      return Object.keys(attrs).length > 0
        ? { type: mark.type, attrs }
        : { type: mark.type };
    })
    .toSorted((a, b) => rank(a.type) - rank(b.type));
}

/** y-tiptap's `hashOfJSON`, which keys overlapping marks of one type apart. */
function hashOfJSON(json: unknown): string {
  const bytes = digest(encodeAny(json));
  const size = 6;
  for (let i = size; i < bytes.length; i++) {
    bytes[i % size] = (bytes[i % size] ?? 0) ^ (bytes[i] ?? 0);
  }
  return toBase64(bytes.slice(0, size));
}

function markAttributes(
  marks: readonly EditorJsonMark[],
  schema: EditorSchemaDescription,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const mark of normalizeMarks(marks, schema)) {
    const attrs = mark.attrs ?? {};
    if (schema.overlappingMarks.includes(mark.type)) {
      // Mark.toJSON(): attrs only when the schema gives the mark any.
      const json =
        Object.keys(attrs).length > 0
          ? { type: mark.type, attrs }
          : { type: mark.type };
      out[`${mark.type}--${hashOfJSON(json)}`] = attrs;
    } else {
      out[mark.type] = attrs;
    }
  }
  return out;
}

function textOf(
  nodes: readonly EditorJsonNode[],
  schema: EditorSchemaDescription,
): Y.XmlText {
  const text = new Y.XmlText();
  text.applyDelta(
    nodes.map((node) => ({
      insert: node.text ?? "",
      attributes: markAttributes(node.marks ?? [], schema),
    })),
  );
  return text;
}

function childrenOf(
  content: readonly EditorJsonNode[],
  schema: EditorSchemaDescription,
): (Y.XmlElement | Y.XmlText)[] {
  const out: (Y.XmlElement | Y.XmlText)[] = [];
  for (let i = 0; i < content.length;) {
    const node = content[i];
    if (node === undefined) break;
    if (node.type === "text") {
      const run: EditorJsonNode[] = [];
      while (content[i]?.type === "text") {
        const next = content[i];
        if (next) run.push(next);
        i++;
      }
      out.push(textOf(run, schema));
    } else {
      out.push(elementOf(node, schema));
      i++;
    }
  }
  return out;
}

function elementOf(
  node: EditorJsonNode,
  schema: EditorSchemaDescription,
): Y.XmlElement {
  const element = new Y.XmlElement(node.type);
  const attrs = withDefaults(schema.nodes[node.type], node.attrs);
  for (const [key, value] of Object.entries(attrs)) {
    if (value !== null && value !== undefined && key !== "ychange") {
      element.setAttribute(key, value as string);
    }
  }
  element.insert(0, childrenOf(node.content ?? [], schema));
  return element;
}

/**
 * Appends the content of `doc` (ProseMirror JSON) to `fragment`, as the
 * editor's Collaboration extension would. The root node's own attrs are not
 * part of the shared document.
 */
export function writeFragment(
  fragment: Y.XmlFragment,
  doc: EditorJsonNode,
  schema: EditorSchemaDescription,
): void {
  fragment.insert(fragment.length, childrenOf(doc.content ?? [], schema));
}

const HASHED_MARK = /(.*)(--[a-zA-Z0-9+/=]{8})$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readText(
  text: Y.XmlText,
  schema: EditorSchemaDescription,
): EditorJsonNode[] {
  const delta = text.toDelta() as TextDeltaItem[];
  return delta.flatMap((item) => {
    if (typeof item.insert !== "string" || item.insert === "") return [];
    const marks = Object.entries(item.attributes ?? {}).map(
      ([key, attrs]): EditorJsonMark => ({
        type: HASHED_MARK.exec(key)?.[1] ?? key,
        ...(isRecord(attrs) && { attrs }),
      }),
    );
    return [
      {
        type: "text",
        text: item.insert,
        ...(marks.length > 0 && { marks: normalizeMarks(marks, schema) }),
      },
    ];
  });
}

function readElement(
  element: Y.XmlElement,
  schema: EditorSchemaDescription,
): EditorJsonNode {
  const content = readChildren(element, schema);
  return {
    type: element.nodeName,
    attrs: withDefaults(
      schema.nodes[element.nodeName],
      element.getAttributes() as Attrs,
    ),
    ...(content.length > 0 && { content }),
  };
}

function readChildren(
  parent: Y.XmlFragment | Y.XmlElement,
  schema: EditorSchemaDescription,
): EditorJsonNode[] {
  return parent.toArray().flatMap((child) => {
    if (child instanceof Y.XmlText) return readText(child, schema);
    if (child instanceof Y.XmlElement) return [readElement(child, schema)];
    return [];
  });
}

/**
 * The ProseMirror JSON of `fragment`'s content, as the editor would see it:
 * unset attrs at their defaults and marks in schema order. The root `doc`
 * node gets `rootAttrs`.
 */
export function readFragment(
  fragment: Y.XmlFragment,
  schema: EditorSchemaDescription,
  rootAttrs: Attrs = {},
): EditorJsonNode {
  return {
    type: "doc",
    attrs: rootAttrs,
    content: readChildren(fragment, schema),
  };
}
