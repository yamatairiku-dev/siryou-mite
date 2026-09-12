import { afterEach, describe, expect, it, vi } from "vitest";
import { logOperationEvent, pseudonymizeSubjectId } from "~/lib/log.server";

/** T09: 運用ログ(設計 §15.2)。 */

afterEach(() => {
  vi.restoreAllMocks();
});

function captureLog(run: () => void): Record<string, unknown> {
  const spy = vi.spyOn(console, "log").mockImplementation(() => {});
  run();
  expect(spy).toHaveBeenCalledTimes(1);
  return JSON.parse(String(spy.mock.calls[0]?.[0])) as Record<string, unknown>;
}

describe("pseudonymizeSubjectId", () => {
  it("同じ利用者IDは同じ値、別の利用者IDは別の値になる", () => {
    expect(pseudonymizeSubjectId("oid-1")).toBe(pseudonymizeSubjectId("oid-1"));
    expect(pseudonymizeSubjectId("oid-1")).not.toBe(pseudonymizeSubjectId("oid-2"));
  });

  it("利用者IDそのものを含まない", () => {
    expect(pseudonymizeSubjectId("oid-1")).not.toContain("oid-1");
    expect(pseudonymizeSubjectId("oid-1")).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("logOperationEvent", () => {
  it("1行1eventのJSONとして記録してよい項目だけを出力する", () => {
    const line = captureLog(() =>
      logOperationEvent({
        event: "document_upload",
        correlationId: "11111111-1111-4111-8111-111111111111",
        result: "denied",
        errorCategory: "quota_exceeded",
        actorSubjectId: "oid-1",
        documentId: "22222222-2222-4222-8222-222222222222",
      }),
    );

    expect(Object.keys(line).sort()).toEqual([
      "actor",
      "correlationId",
      "documentId",
      "errorCategory",
      "event",
      "result",
      "time",
    ]);
    expect(line.actor).toBe(pseudonymizeSubjectId("oid-1"));
    expect(JSON.stringify(line)).not.toContain("oid-1");
  });

  it("利用者IDが無い場合はactorをnullにする", () => {
    const line = captureLog(() =>
      logOperationEvent({
        event: "document_upload",
        correlationId: "11111111-1111-4111-8111-111111111111",
        result: "success",
      }),
    );

    expect(line.actor).toBeNull();
    expect(line.errorCategory).toBeNull();
    expect(line.documentId).toBeNull();
  });

  it("出力に失敗しても例外を投げない(業務処理を止めない)", () => {
    vi.spyOn(console, "log").mockImplementation(() => {
      throw new Error("stdout closed");
    });

    expect(() =>
      logOperationEvent({
        event: "document_upload",
        correlationId: "11111111-1111-4111-8111-111111111111",
        result: "success",
      }),
    ).not.toThrow();
  });
});
