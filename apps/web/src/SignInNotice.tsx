import { loginHref } from "./api";
import { EmptyState } from "./EmptyState";
import { RailLayout } from "./Rail";

/** API がログインを求めた（cookie の期限切れなど）ときの、ログインへの案内。 */
export function SignInNotice({ expired = false }: { expired?: boolean }) {
  const login = (
    <a className="button button-primary" href={loginHref(window.location)}>
      {expired ? "ログインし直す" : "ログイン"}
    </a>
  );
  return (
    <RailLayout rail={null}>
      {expired ? (
        <EmptyState
          level={1}
          title="ログインの期限が切れました"
          // 再読み込みで匿名に戻れるのは、/api/me が検証できない cookie を消すため
          text="ログインせずに公開ページを読むには、再読み込みしてください。"
          actions={login}
        />
      ) : (
        <EmptyState level={1} title="ページを作るにはログインが必要です" actions={login} />
      )}
    </RailLayout>
  );
}
