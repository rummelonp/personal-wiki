import { loginHref } from "./api";

/** Phase 6 までは owner 以外に見せるページが無いので、ログインへの案内だけを出す。 */
export function SignInNotice({ expired = false }: { expired?: boolean }) {
  return (
    <section className="notice">
      <h1 className="notice-title">
        {expired ? "ログインの期限が切れました" : "ログインが必要です"}
      </h1>
      <p className="muted">ページの閲覧と編集はログインした後に使えます。</p>
      <p>
        <a className="button button-primary" href={loginHref(window.location)}>
          ログイン
        </a>
      </p>
    </section>
  );
}
