import { describe, expect, it } from "vitest";
import { meta } from "~/root";

type MetaArgs = Parameters<typeof meta>[0];

function titleOf(loaderData: MetaArgs["loaderData"]): unknown {
  const descriptors = meta({ loaderData } as MetaArgs);
  const descriptor = descriptors.find((item) => "title" in item) as
    | { title?: unknown }
    | undefined;
  return descriptor?.title;
}

describe("root meta", () => {
  it("<title>にAPP_NAME(loaderのappName)を使う", () => {
    expect(titleOf({ appName: "資料みて！(検証)", user: null })).toBe(
      "資料みて！(検証)",
    );
  });

  it("loaderDataが無いエラー画面では既定のアプリ名にする", () => {
    expect(titleOf(undefined)).toBe("資料みて！");
  });
});
