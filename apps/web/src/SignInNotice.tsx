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
        text={
          expired
            ? "続けるにはログインし直してください。再読み込みすると、ログインせずに公開ページを読めます。"
            : "ページの作成はログインした後に使えます。"
        }
        actions={
          <a className="button button-primary" href={loginHref(window.location)}>
            ログイン
          </a>
        }
      />
    </RailLayout>
  );
}
