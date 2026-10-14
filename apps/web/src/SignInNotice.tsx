import { loginHref } from "./api";
import { EmptyState } from "./EmptyState";
import { RailLayout } from "./Rail";

/** API がログインを求めた（cookie の期限切れなど）ときの、ログインへの案内。 */
export function SignInNotice({ expired = false }: { expired?: boolean }) {
  return (
    <RailLayout rail={null}>
      <EmptyState
        level={1}
        title={expired ? "ログインの期限が切れました" : "ログインが必要です"}
        text="ページの編集はログインした後に使えます。"
        actions={
          <a className="button button-primary" href={loginHref(window.location)}>
            ログイン
          </a>
        }
      />
    </RailLayout>
  );
}
