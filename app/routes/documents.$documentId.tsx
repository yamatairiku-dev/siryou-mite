/**
 * 資料表示画面(設計 §5.4, §7.2, §9.2, §10.3, §13の`/documents/:documentId`)。
 *
 * - 固定URLは`/documents/{documentId}`。未ログインは`requireUser`が
 *   `/auth/login?returnTo=<このURLのpathname+search>`へredirectし、ログイン後に
 *   同じURLへ戻る(`app/lib/session.server.ts`の既存実装のまま。open redirect対策の
 *   `safeInternalPath`もそのまま使う。この画面のために変更していない)。
 * - 所有者以外でも、URLを知っているログイン済み利用者であれば閲覧できる
 *   (`authorizeDocumentView`/`assertCanViewDocument`が判定する。owner限定にしない)。
 * - 資料が`active`でない(削除済み・未存在)場合と、`documentId`がUUID形式でない
 *   場合は、いずれも同じ404「資料が見つかりません」にする(設計 §10.4, §14)。
 *   UUID形式チェックは`findDocumentById`を呼ぶ前に行い、不正な値でDBへ触れない
 *   (AGENTS.md 6項)。
 * - このloaderは資料の閲覧のみを行い、DBやBlobへの更新を伴わない(mutationではない)
 *   ため`assertSameOrigin`は呼ばない(AGENTS.md 7項は「cookie認証mutation
 *   action」が対象で、このrouteはloaderだけで完結しactionを持たない)。
 * - grantはloaderの戻り値としてクライアントへ渡す必要があるため、`logOperationEvent`
 *   などのログには一切出さない(設計 §9.5)。この画面自体は監査を書かない
 *   (閲覧成功監査はDisplay側がHTMLを返す直前に保存する、設計 §10.3(6)、T12)。
 */
import { useEffect, useRef } from "react";
import { useRevalidator } from "react-router";
import { z } from "zod";
import type { Route } from "./+types/documents.$documentId";
import {
  assertCanViewDocument,
  isDocumentOwner,
} from "~/lib/auth/authorization.server";
import { findDocumentById } from "~/lib/db/documents.server";
import { env } from "~/lib/env.server";
import { DISPLAY_GRANT_FORM_FIELD, issueDisplayGrant } from "~/lib/grant.server";
import { requireUser } from "~/lib/session.server";

const documentIdParamSchema = z.uuid();

export type DocumentViewLoaderData = {
  documentId: string;
  title: string;
  /** hidden formのPOST先を組み立てるための表示サービスorigin(秘密情報ではない)。 */
  displayOrigin: string;
  /** 表示grant。ログへは出さず、hidden formのPOST bodyだけへ渡す。 */
  grant: string;
  /** grantの失効時刻(epoch ms)。期限切れ間際の再送信を避けるために使う。 */
  grantExpiresAt: number;
  grantFormField: string;
  /**
   * 所有者本人にだけ削除導線(削除確認画面へのリンク)を表示する(設計 §5.2, §5.5)。
   * 表示可否であって認可ではない。削除の可否は削除action側が再判定する
   * (AGENTS.md 5項)。
   */
  canDelete: boolean;
};

export async function loader({
  request,
  params,
}: Route.LoaderArgs): Promise<DocumentViewLoaderData> {
  // 未ログインならここで`/auth/login?returnTo=...`へredirectする(設計 §5.4)。
  const user = await requireUser(request);

  // UUID形式でない`documentId`はDBへ触れる前に拒否する。存在有無を漏らさないため、
  // 以降は`document = null`のときと同じ404経路(`assertCanViewDocument`)へ合流させる。
  const parsedDocumentId = documentIdParamSchema.safeParse(params.documentId);
  const document = parsedDocumentId.success
    ? await findDocumentById(parsedDocumentId.data)
    : null;

  // 所有者以外でも閲覧できるが、`active`でない資料(削除済み・未存在)は
  // 一般利用者には同じ404として拒否する(設計 §10.3(2), §10.4, §14)。
  assertCanViewDocument(user, document);
  if (!document) {
    // 上の`assertCanViewDocument`が必ず例外を投げるため到達しないが、
    // 非nullを型として確定させるためのfail closedな保険。
    throw new Response("資料が見つかりません", { status: 404 });
  }

  const now = new Date();
  const grant = issueDisplayGrant(
    { documentId: document.id, user },
    { now },
  );

  return {
    documentId: document.id,
    title: document.title ?? document.originalFileName ?? "資料",
    displayOrigin: env.DISPLAY_ORIGIN,
    grant,
    grantExpiresAt: now.getTime() + env.GRANT_TTL_SECONDS * 1000,
    grantFormField: DISPLAY_GRANT_FORM_FIELD,
    canDelete: isDocumentOwner(user, document),
  };
}

export const meta: Route.MetaFunction = () => [{ title: "資料みて！" }];

/**
 * hydration遅延などで発行済みgrantが期限切れ間際になっていた場合に、
 * それを送信せず新しいgrantを取り直すための安全余裕(ms)。
 */
const GRANT_REFRESH_BUFFER_MS = 5_000;

export default function DocumentView({ loaderData }: Route.ComponentProps) {
  const revalidator = useRevalidator();
  const formRef = useRef<HTMLFormElement>(null);
  // 直前に送信済みのgrant値。同じgrantの二重送信(React 18 Strict Modeの
  // 開発時二重effectなど)を避けるためだけに使い、業務的な単回使用制御ではない
  // (grantの有効期限内の再利用自体は許容する、設計判断Q-019)。
  const submittedGrantRef = useRef<string | null>(null);

  useEffect(() => {
    if (submittedGrantRef.current === loaderData.grant) {
      return;
    }

    const remainingMs = loaderData.grantExpiresAt - Date.now();
    if (remainingMs <= GRANT_REFRESH_BUFFER_MS) {
      // 発行から実際にここへ到達するまでに時間がかかり、grantが期限切れ間際・
      // 期限切れになっている場合は、送信せずに新しいgrantを取り直す
      // (loaderを再実行してもらう。設計 §7.2のgrant有効期間60秒への対策)。
      revalidator.revalidate();
      return;
    }

    submittedGrantRef.current = loaderData.grant;
    // アプリJavaScriptが一時的なhidden formからgrantをPOST bodyでiframeへ送る
    // (設計 §10.3(4))。URL・クエリ文字列・Cookieでは送らない。
    formRef.current?.requestSubmit();
    // revalidatorは呼び出しごとに新しい参照を持ち得るため依存に含めない
    // (依存に含めると`revalidate`呼び出し後の再描画で不要な再実行を招く)。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaderData.grant, loaderData.grantExpiresAt]);

  async function copyDocumentUrl(): Promise<void> {
    // コピー対象はアプリ側の固定URLだけ。DisplayのURLやgrantはコピー対象に
    // 含めない(設計 §7.2末尾、§5.4)。
    const url = `${window.location.origin}/documents/${loaderData.documentId}`;
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      // clipboard APIが使えない環境では黙って諦める(業務結果に影響しない)。
    }
  }

  function retryDisplay(): void {
    // Displayのiframe内容は別オリジン・sandboxのためJavaScriptから読めず、
    // 期限切れなどの失敗を自動検出できない。利用者が手動で新しいgrantを
    // 取り直して再送信できる導線を用意する(設計判断。QUESTIONS.md Q-024)。
    revalidator.revalidate();
  }

  const displayActionUrl = `${loaderData.displayOrigin}/display`;
  const iframeName = `document-display-${loaderData.documentId}`;

  return (
    <section>
      <p className="eyebrow">資料みて！</p>
      <h1>{loaderData.title}</h1>

      <div className="document-view-actions">
        <button
          type="button"
          className="button button-secondary"
          onClick={() => void copyDocumentUrl()}
        >
          URLをコピー
        </button>
        <a className="button button-secondary" href="/app">
          初期画面へ戻る
        </a>
        <button
          type="button"
          className="button button-secondary"
          onClick={retryDisplay}
        >
          表示をやり直す
        </button>
        {loaderData.canDelete && (
          // 削除確認画面(設計 §5.5)へ遷移するだけのリンク。ここでは削除しない。
          <a
            className="button button-secondary"
            href={`/documents/${loaderData.documentId}/delete`}
          >
            削除
          </a>
        )}
      </div>

      {/*
        アプリJavaScriptが生成する一時的なhidden form(設計 §7.2, §10.3(4))。
        `application/x-www-form-urlencoded`のPOST bodyでgrantをiframeへ送る。
        grantはURL・クエリ文字列・Cookieでは送らない。送信先(`displayActionUrl`)
        にはクエリ文字列を付けない(Displayはクエリ付きの要求を拒否する)。
      */}
      <form
        ref={formRef}
        method="post"
        action={displayActionUrl}
        target={iframeName}
        encType="application/x-www-form-urlencoded"
        hidden
        aria-hidden="true"
        data-testid="display-grant-form"
      >
        <input
          type="hidden"
          name={loaderData.grantFormField}
          value={loaderData.grant}
        />
      </form>

      <iframe
        name={iframeName}
        title={`${loaderData.title}の内容`}
        className="document-view-frame"
        // sandboxは`allow-popups`と`allow-popups-to-escape-sandbox`だけを許可する
        // (設計 §9.2)。script・form・download・same-origin・
        // `target="_top"`/`target="_parent"`による親画面遷移は許可しない。
        sandbox="allow-popups allow-popups-to-escape-sandbox"
        referrerPolicy="no-referrer"
        data-testid="document-display-frame"
      />

      <noscript>
        {/*
          アプリのJavaScriptを必須とし、無効時は資料本文を表示しない
          (設計 §5.4)。手動POSTのfallbackは設けない(設計 §10.3(7))。
        */}
        <p className="notice" role="alert">
          この資料の表示にはJavaScriptが必要です。ブラウザの設定でJavaScriptを有効にしてください。
        </p>
      </noscript>
    </section>
  );
}
