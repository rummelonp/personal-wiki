// ログアウトの操作から入口の chunk に入るので、editor-session（Markdown の解析器を引き込む）を import しない

export interface SavableEditor {
  /** 打っている途中の title を確定してから保存する */
  commitTitle(): Promise<void>;
}

const editors = new Set<SavableEditor>();

/** 開いている編集画面の登録。ログアウトの前に全部の保存を待つために使う。戻り値で外す。 */
export function registerEditor(editor: SavableEditor): () => void {
  editors.add(editor);
  return () => {
    editors.delete(editor);
  };
}

export const SAVE_ALL_TIMEOUT_MS = 5000;

/**
 * ログアウトの前に、開いている編集画面の未保存の内容を送る。
 * 先にログアウトすると保存が 401 になり、入力した内容が手元の退避だけになるため。
 * 打っている途中の title は blur の確定に任せない。ログアウトの押下で blur が先に届く保証は無く、
 * 届かなければ title は保存にも退避にも入らず失われるため、ここで確定してから保存する。
 * まだ作っていないページも、title があればここで作る（作る前の内容を退避だけにしない）。
 *
 * 退避（localStorage）はここでは消さない。保存が失敗した、または間に合わなかった内容の唯一の写しであり、
 * 保存が成功した分はセッションが自分で消す。残った分は、次にそのページを開いたときに復元か破棄を選べる。
 * 待つのは保存の完了まででよく、失敗や遅延でログアウトを止めない（タイムアウトで先へ進む）。
 */
export async function saveAllEditors(timeoutMs = SAVE_ALL_TIMEOUT_MS): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  try {
    await Promise.race([
      Promise.allSettled([...editors].map((editor) => editor.commitTitle())),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}
