import type { EditorJsonNode } from "@docleus/sdk";
import { Node as PmNode } from "@tiptap/pm/model";
import {
  prosemirrorJSONToYXmlFragment,
  yXmlFragmentToProseMirrorRootNode,
} from "@tiptap/y-tiptap";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  createEditorSchema,
  describeSchema,
} from "../../tests/editor-schema.ts";
import { readFragment, writeFragment } from "./encoding.ts";

const schema = createEditorSchema();
const description = describeSchema(schema);

/** The shape of a fragment, without Yjs item ids. */
function dump(type: Y.XmlFragment | Y.XmlElement | Y.XmlText): unknown {
  if (type instanceof Y.XmlText) return { text: type.toDelta() };
  if (type instanceof Y.XmlElement) {
    return {
      name: type.nodeName,
      attrs: type.getAttributes(),
      children: type.toArray().map((child) => dump(child as Y.XmlText)),
    };
  }
  return type.toArray().map((child) => dump(child as Y.XmlText));
}

const paragraph = (
  id: string,
  content: EditorJsonNode[],
  attrs: Record<string, unknown> = {},
): EditorJsonNode => ({
  type: "paragraph",
  attrs: { blockId: id, blockVersion: 1, ...attrs },
  content,
});

const DOCS: Record<string, EditorJsonNode> = {
  plain: {
    type: "doc",
    content: [paragraph("p1", [{ type: "text", text: "Hello" }])],
  },
  "marks in any order": {
    type: "doc",
    content: [
      paragraph("p1", [
        { type: "text", text: "a" },
        {
          type: "text",
          text: "b",
          marks: [{ type: "italic" }, { type: "bold" }],
        },
        {
          type: "text",
          text: "c",
          marks: [
            { type: "code" },
            { type: "link", attrs: { href: "https://example.com" } },
          ],
        },
        { type: "text", text: "d", marks: [{ type: "strike" }] },
      ]),
    ],
  },
  "defaults and nesting": {
    type: "doc",
    content: [
      {
        type: "test_callout",
        attrs: { blockId: "c1", blockVersion: 2 },
        content: [
          {
            type: "test_heading",
            attrs: { blockId: "h1", blockVersion: 1, level: 3 },
            content: [{ type: "text", text: "Title" }],
          },
          paragraph("p2", []),
        ],
      },
      {
        type: "test_heading",
        attrs: { blockId: "h2", blockVersion: 1 },
        content: [{ type: "text", text: "Default level" }],
      },
    ],
  },
};

describe("writeFragment", () => {
  it.each(Object.entries(DOCS))(
    "writes what y-tiptap writes (%s)",
    (_name, json) => {
      const expected = prosemirrorJSONToYXmlFragment(
        schema,
        json,
        new Y.Doc().getXmlFragment("default"),
      );
      const actual = new Y.Doc().getXmlFragment("default");
      writeFragment(actual, json, description);
      expect(dump(actual)).toEqual(dump(expected));
    },
  );
});

describe("readFragment", () => {
  it.each(Object.entries(DOCS))(
    "reads what the editor would show (%s)",
    (_name, json) => {
      const fragment = prosemirrorJSONToYXmlFragment(
        schema,
        json,
        new Y.Doc().getXmlFragment("default"),
      );
      const shown = yXmlFragmentToProseMirrorRootNode(fragment, schema);
      expect(
        readFragment(
          fragment,
          description,
          shown.attrs as Record<string, unknown>,
        ),
      ).toEqual(shown.toJSON());
      expect(
        readFragment(
          fragment,
          description,
          shown.attrs as Record<string, unknown>,
        ),
      ).toEqual(PmNode.fromJSON(schema, json).toJSON());
    },
  );

  it("round-trips its own encoding", () => {
    for (const json of Object.values(DOCS)) {
      const fragment = new Y.Doc().getXmlFragment("default");
      writeFragment(fragment, json, description);
      const normalized = PmNode.fromJSON(
        schema,
        json,
      ).toJSON() as EditorJsonNode;
      expect(readFragment(fragment, description, normalized.attrs)).toEqual(
        normalized,
      );
    }
  });
});
