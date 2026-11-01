# 2026-11-01 GoogleマップURL連動の公開

ユーザーの「公開して」の承認を受け、23店舗のGoogleマップURL自動入力を公開。

- 機能コミット：`bd673d534907c6d6f82fb514932c96f8c4037fee`
- GitHub Pages：[run 41308139975](https://github.com/MARUGO-s/restaurant-insight-studio/actions/runs/41308139975) 成功。
- 公開URL：https://marugo-s.github.io/restaurant-insight-studio/
- 基点・復旧先：`74ae7e5ed06510b3fcac6888b97ba46e8ab7b1b2`。Googleマップ機能コミットをrevertしてPagesを再配布する方法を使用し、共有mainのreset/force-pushは行わない。
- フロントのみの変更。Supabase Function、DB、認証、保存レポート、料金計測は変更していない。

## 実装と検証

各公式ページとGoogle Maps画面から23個店URLを確認。マルゴエスは公式に載る施設全体ではなく店舗専用ページを採用。候補の明示選択で公式・食べログ・Googleマップを設定し、自由入力・手修正・他欄・チェックOFFを保持。初期の四谷URLも同じカタログを使い、調査対象の初期値は従来どおり食べログのみ。

追加前RED、実装後GREEN。Deno90件、レポート表示、既存店舗コンポーネントUI、新規実App隔離試験、型検査/build成功。独立レビュー通過。公開直前にも静的検査・表示・実App・buildを再実行し、実装差分が独立レビュー時と同一と確認した。

公開artifactを取得し、HTML/JS/CSS全3ファイルを通常URL・cache-bust URLの計6取得でバイト比較してすべて一致。JS `assets/index-Dyp3nUnz.js` のSHA-256は `825b223ccfac129ec736660a0a242326ae853496ffa2218635134f026466b31d`。CSS `assets/index-nDvswugn.css` は先行公開と同一。

公開サイトの配布JSを実ブラウザで実行し、合成認証とAPI捕捉の下で全23店舗の3媒体URL、初期値、食べログ/GoogleマップOFF保持、グループ/重点保持、自由入力と手修正、送信payload、エラー時入力保持、390px候補表示を確認。pageerrorなし。本番業務APIリクエストは0件。

## 検証限界

合成認証/API遮断試験は実ユーザーのログイン、保存や有料分析完走を証明しない。Google Mapsは表示制限の注記があり、個店同定に必要な情報を確認したが口コミ全件取得を保証しない。実日本語IME/Safari変換確定は未検証。buildの500kB超チャンク警告、Actionsのランタイム移行注記は残る。

ローカル証跡：Hermes scratch `ris-google-maps/release/` の `pages-verification.json`、`live-smoke.json` と配布artifact。URL同定根拠は [店舗URL一覧](store-url-catalog.md)、入力仕様・回帰は [店舗名入力](store-name-input.md)。後続の公開記録だけのコミットは、この機能コミットを動作の基点として扱う。
