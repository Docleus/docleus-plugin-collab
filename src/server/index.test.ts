import { DocleusError } from "@docleus/sdk";
import { describe, expect, it } from "vitest";
import { DEFAULT_IDLE_DELAY_MS, parseCollabConfig } from "./index.ts";

describe("parseCollabConfig", () => {
  it("defaults the idle delay", () => {
    expect(parseCollabConfig(undefined)).toEqual({
      idleDelay: DEFAULT_IDLE_DELAY_MS,
    });
    expect(parseCollabConfig({})).toEqual({ idleDelay: DEFAULT_IDLE_DELAY_MS });
  });

  it("takes a positive idle delay", () => {
    expect(parseCollabConfig({ idleDelay: 500 })).toEqual({ idleDelay: 500 });
  });

  it.each([[0], [-1], ["1000"], [Number.NaN], [Number.POSITIVE_INFINITY]])(
    "rejects an idle delay of %s",
    (idleDelay) => {
      expect(() => parseCollabConfig({ idleDelay })).toThrow(
        expect.objectContaining({
          code: "collab/invalid-config",
          message: '"idleDelay" must be a positive number of milliseconds',
        }),
      );
    },
  );

  it("rejects a config that is not an object", () => {
    expect(() => parseCollabConfig(["idleDelay"])).toThrow(DocleusError);
    expect(() => parseCollabConfig("fast")).toThrow(
      expect.objectContaining({
        code: "collab/invalid-config",
        message: "the config must be an object",
      }),
    );
  });
});
