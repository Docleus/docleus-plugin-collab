import type { EditorSchemaDescription } from "@docleus/sdk";
import { Extension, getSchema, Node } from "@tiptap/core";
import { Bold } from "@tiptap/extension-bold";
import { Code } from "@tiptap/extension-code";
import { Document } from "@tiptap/extension-document";
import { Italic } from "@tiptap/extension-italic";
import { Link } from "@tiptap/extension-link";
import { Paragraph } from "@tiptap/extension-paragraph";
import { Strike } from "@tiptap/extension-strike";
import { Text } from "@tiptap/extension-text";
import type { Schema } from "@tiptap/pm/model";

/** A block with an attr that has a non-null default, like a heading level. */
const Heading = Node.create({
  name: "test_heading",
  group: "block",
  content: "inline*",
  addAttributes: () => ({ level: { default: 1 }, anchor: { default: null } }),
  renderHTML: () => ["h1", 0],
});

const Callout = Node.create({
  name: "test_callout",
  group: "block",
  content: "block+",
  addAttributes: () => ({ tone: { default: "info" } }),
  renderHTML: () => ["aside", 0],
});

/** The core schema of docleus-plugin-editor plus two test blocks. */
export function createEditorSchema(): Schema {
  return getSchema([
    Document,
    Paragraph,
    Text,
    Link.configure({
      openOnClick: false,
      autolink: false,
      HTMLAttributes: { target: null, rel: null, class: null },
    }),
    Strike,
    Bold,
    Italic,
    Code.extend({ excludes: "" }),
    Heading,
    Callout,
    Extension.create({
      name: "blockAttributes",
      addGlobalAttributes: () => [
        {
          types: ["doc", "paragraph", "test_heading", "test_callout"],
          attributes: {
            blockId: { default: null, rendered: false },
            blockVersion: { default: null, rendered: false },
          },
        },
      ],
    }),
  ]);
}

function defaults(
  attrs: Readonly<Record<string, { default?: unknown }>>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(attrs).map(([name, spec]) => [name, spec.default ?? null]),
  );
}

/** What docleus-plugin-editor sends the server about its schema. */
export function describeSchema(schema: Schema): EditorSchemaDescription {
  return {
    nodes: Object.fromEntries(
      Object.entries(schema.nodes).map(([name, type]) => [
        name,
        defaults(type.spec.attrs ?? {}),
      ]),
    ),
    marks: Object.fromEntries(
      Object.entries(schema.marks).map(([name, type]) => [
        name,
        defaults(type.spec.attrs ?? {}),
      ]),
    ),
    overlappingMarks: Object.values(schema.marks)
      .filter((type) => !type.excludes(type))
      .map((type) => type.name),
  };
}
