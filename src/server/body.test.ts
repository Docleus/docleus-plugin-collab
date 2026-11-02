import type { BlockNode } from "@docleus/sdk";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  createEditorSchema,
  describeSchema,
} from "../../tests/editor-schema.ts";
import { bodyOfFragment, seedFragment } from "./body.ts";
import { sameTree } from "./reuse.ts";

const schema = describeSchema(createEditorSchema());

const text = (id: string, value: string): BlockNode => ({
  id,
  type: "paragraph",
  v: 1,
  attrs: {},
  inline: [{ type: "text", text: value }],
});

const BODY: BlockNode = {
  id: "root",
  type: "doc",
  v: 1,
  attrs: {},
  content: [
    text("p1", "One"),
    {
      id: "p2",
      type: "paragraph",
      v: 1,
      attrs: {},
      inline: [
        { type: "text", text: "Two " },
        { type: "text", text: "bold", marks: [{ type: "bold" }] },
      ],
    },
  ],
};

function fragmentOf(body: BlockNode): Y.XmlFragment {
  const fragment = new Y.Doc().getXmlFragment("default");
  seedFragment(fragment, schema, body);
  return fragment;
}

function paragraphAt(fragment: Y.XmlFragment, index: number): Y.XmlElement {
  const node = fragment.get(index);
  if (!(node instanceof Y.XmlElement)) throw new Error("not a paragraph");
  return node;
}

describe("bodyOfFragment", () => {
  it("reads back the body it was seeded with", () => {
    const body = bodyOfFragment(fragmentOf(BODY), schema, BODY);
    expect(sameTree(body, BODY)).toBe(true);
    expect(body.content?.[0]).toBe(BODY.content?.[0]);
  });

  it("keeps untouched blocks and replaces edited ones", () => {
    const fragment = fragmentOf(BODY);
    const first = paragraphAt(fragment, 0).get(0);
    if (!(first instanceof Y.XmlText)) throw new Error("no text");
    first.insert(3, "!");

    const body = bodyOfFragment(fragment, schema, BODY);
    expect(body.id).toBe("root");
    expect(body.content?.[0]).toEqual(text("p1", "One!"));
    expect(body.content?.[1]).toBe(BODY.content?.[1]);
  });

  it("gives new and copied blocks fresh ids", () => {
    const fragment = fragmentOf(BODY);
    const copy = paragraphAt(fragment, 0).clone();
    const fresh = new Y.XmlElement("paragraph");
    fresh.insert(0, [new Y.XmlText("Three")]);
    fragment.push([copy, fresh]);

    const ids = (bodyOfFragment(fragment, schema, BODY).content ?? []).map(
      (block) => block.id,
    );
    expect(ids.slice(0, 2)).toEqual(["p1", "p2"]);
    expect(new Set(ids).size).toBe(4);
    expect(ids).not.toContain("root");
  });

  it("keeps the root attrs, which the editor never sees", () => {
    const synced = { ...BODY, attrs: { layout: "wide" } };
    const body = bodyOfFragment(fragmentOf(synced), schema, synced);
    expect(body.attrs).toEqual({ layout: "wide" });
  });
});

describe("seedFragment", () => {
  it("gives an empty page one paragraph to type in", () => {
    const fragment = fragmentOf({ ...BODY, content: [] });
    expect(fragment.length).toBe(1);
    expect(paragraphAt(fragment, 0).nodeName).toBe("paragraph");
    expect(paragraphAt(fragment, 0).getAttribute("blockId")).toEqual(
      expect.any(String),
    );
  });
});
