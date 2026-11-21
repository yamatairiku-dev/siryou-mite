import { describe, expect, it } from "vitest";
import { isWideLayout } from "~/lib/format/layout";

describe("isWideLayout", () => {
  it("どれかのrouteが広い幅を選んでいればtrue", () => {
    expect(isWideLayout([{ handle: undefined }, { handle: { layout: "wide" } }])).toBe(true);
  });

  it("handleが無い・別の値ならfalse", () => {
    expect(isWideLayout([])).toBe(false);
    expect(isWideLayout([{ handle: undefined }, { handle: null }, { handle: {} }])).toBe(false);
    expect(isWideLayout([{ handle: "wide" }, { handle: { layout: "narrow" } }])).toBe(false);
  });
});
