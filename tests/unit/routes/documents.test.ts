import { describe, expect, it } from "vitest";
import { action, loader } from "~/routes/documents";

/** T09: `/documents`(アップロードaction。設計 §13)。 */

function actionArgs(request: Request) {
  // route moduleはrequestだけを使う。型生成された引数の残りはテストで使わない。
  return { request } as unknown as Parameters<typeof action>[0];
}

describe("GET /documents", () => {
  it("アップロード専用のため405を返す", async () => {
    const response = await loader();

    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("POST");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });
});

describe("POST以外のmutation", () => {
  it("DELETEを405で拒否する", async () => {
    const response = await action(
      actionArgs(new Request("http://localhost:3000/documents", { method: "DELETE" })),
    );

    expect(response.status).toBe(405);
  });
});

describe("POST /documents", () => {
  it("未認証の要求はログイン画面へ戻す(処理本体へ委譲している)", async () => {
    await expect(
      action(
        actionArgs(
          new Request("http://localhost:3000/documents", {
            method: "POST",
            headers: {
              Origin: "http://localhost:3000",
              "Content-Type": "application/octet-stream",
            },
            body: "<!doctype html>",
          }),
        ),
      ),
    ).rejects.toMatchObject({ status: 302 });
  });
});
