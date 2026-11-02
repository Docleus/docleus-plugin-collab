import { describe, expect, it } from "vitest";
import {
  documentNameOf,
  parseCollabMessage,
  parseDocumentName,
  parseSchemaDescription,
} from "./index.ts";

describe("document names", () => {
  it("round-trip, with slashes in the branch", () => {
    const target = { spaceId: "s1", branch: "cr/12", entryId: "e1" };
    expect(documentNameOf(target)).toBe("s1/cr/12/e1");
    expect(parseDocumentName(documentNameOf(target))).toEqual(target);
  });

  it.each([["s1"], ["s1/e1"], ["/main/e1"], ["s1/main/"], ["s 1/main/e1"]])(
    "rejects %j",
    (name) => {
      expect(parseDocumentName(name)).toBeUndefined();
    },
  );
});

describe("parseCollabMessage", () => {
  it("reads the known messages", () => {
    expect(parseCollabMessage('{"type":"save","id":"1"}')).toEqual({
      type: "save",
      id: "1",
    });
    expect(
      parseCollabMessage('{"type":"save-failed","id":"1","message":"no"}'),
    ).toEqual({ type: "save-failed", id: "1", message: "no" });
  });

  it.each([["nope"], ['{"type":"save"}'], ['{"type":"other","id":"1"}']])(
    "ignores %j",
    (text) => {
      expect(parseCollabMessage(text)).toBeUndefined();
    },
  );
});

describe("parseSchemaDescription", () => {
  it("accepts a description and rejects a malformed one", () => {
    const description = {
      nodes: { paragraph: { blockId: null } },
      marks: { bold: {} },
      overlappingMarks: ["code"],
    };
    expect(parseSchemaDescription(description)).toEqual(description);
    expect(
      parseSchemaDescription({ ...description, overlappingMarks: [1] }),
    ).toBeUndefined();
    expect(
      parseSchemaDescription({ ...description, nodes: { paragraph: 1 } }),
    ).toBeUndefined();
  });
});
