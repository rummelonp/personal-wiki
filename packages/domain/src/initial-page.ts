/**
 * SPA の初回の表示に使うページの JSON を、Worker が HTML に入れる `<script>` 要素の id。
 * Worker が書き、web が読むので、片方だけ変えると web が JSON を見つけられず毎回 API を引き直す。
 */
export const INITIAL_PAGE_ELEMENT_ID = "initial-page";
