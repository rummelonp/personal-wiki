import { loginHref } from "./api";

/** API がログインを求めた（cookie の期限切れなど）ときの、ログインへの案内。 */
export function SignInNotice({ expired = false }: { expired?: boolean }) {
  return (
    <section className="notice">
      <h1 className="notice-title">
        {expired ? "ログインの期限が切れました" : "ログインが必要です"}
      </h1>
      <p className="muted">ページの編集はログインした後に使えます。</p>
      <p>
        <a className="button button-primary" href={loginHref(window.location)}>
          ログイン
        </a>
      </p>
    </section>
  );
}
