# 2026-11-01 引用復旧・統合1回の承認再生成の公開

## 公開状態

ユーザーの「完成したら本番反映してください」に基づき、検証と独立レビュー後に本番反映した。初回機能コミット `6b483536d16d8ba3724198f414d467afb3992a27`、Pages run `41312833555` に続き、斜体・入れ子リストの無料復旧を `6b5bd919da7348313f537dd3754d48ef411887b2`、Pages run `41314438578` で公開。両runともbuild/deploy成功。公開URLは https://marugo-s.github.io/restaurant-insight-studio/ 。

Supabase project `gourmet`（`ycsqfajidusuibqljjwr`）へ新migration `20261101090000_restaurant_insight_synthesis_regeneration.sql` だけを適用した。最終API `restaurant-analysis` v39（JWT必須）、worker `restaurant-analysis-worker` v23（単発dispatch token照合）はACTIVE。migration→worker→API→UIの順で反映し、認証方式・他アプリ・既存レポート一括更新は変更していない。

## 検証結果

- Denoネットワーク禁止：134 passed（36 steps）、0 failed。表示回帰、23店舗検査、build、diff検査成功。
- 独立レビューのコードフェンス誤復旧2件を修正。初回再レビューは関連45件・36ステップに加え168補助ケースで阻害問題なし。後続の斜体対応もUnicode境界を修正し、関連33件・36ステップとCommonMark比較576ケースで最終レビュー合格。品質・出典検査を緩めていない。
- PostgreSQL 17隔離試験で既存SQL・新RPC、所有者・revision・冪等性・RLS・排他・1世代1試行を確認。実際に適用するtransaction wrapperも隔離試験に通した。
- 本番migrationは既存9関数の定義MD5をガードし、既存6テーブルの全行fingerprint不変をtransaction内で確認。ledgerに保存したmigration本文、RPC本文、権限、RLS、policy、unique index、空のarchiveを適用後に読み戻した。
- 両Functionを再取得し、2つのbundleの計12ソースが公開コードとバイト一致。他Functionのmetadataは不変。
- Pagesの配布artifact全3ファイルを、通常URL・cache-bustの計6取得と比較し全一致。公開実Appの23店舗・3媒体URL・手修正・OFF媒体・他入力・送信payload・エラー時入力保持を合成認証/API遮断で確認。
- 公開実Appの有料再生成ボタン、同意取消、1回のUUID＋revision送信、応答不明表示、入力保持も合成認証/API遮断で確認。以上の画面試験は実ログインや実生成とは別の検証。

## 承認済み解析の実行

ユーザー承認は「完了済み4専門調査を残し、統合のみ1回追加生成」に限定される。配布照合後、この1回を実行した。新応答は斜体省略1件で一度停止したが、同じ完成済み応答を無料で再検査して復旧した。最終的にrunと統合jobがdone、完成レポート1件・品質v3・10章・38主張の保存を読み戻した。旧統合outputのarchive、4専門調査、新旧の統合原稿は保持。追加料金イベントは統合1件のみで、提供元応答・利用量取得完了。無料再確認では料金行が増えておらず、既存行の金額・利用量・出典metadataも不変だった。既存finish_jobの仕様どおり6料金行のreport_idだけを完成レポートへ紐付けた。標準料金は私有証跡に保存し、請求書確定額とは区別する。

本番保存レポートは、検証時刻以外がオフラインで全検査を通した内容と完全一致した。実保存本文の表示回帰も成功。390/768/1440pxで横はみ出し・ブラウザ例外なし、6課題・6施策・10章と導入の表示を確認。画面試験自体はネットワーク遮断で行い、本番保存は別の読み戻しで検証した。

2回目の追加生成を自動で行わない。実行ID・所有者・provider応答・原稿・個別の料金行は私有scratchに隔離し、公開資料へ転載しない。

## 残る制限

品質ゲートは引用・URL追跡・構造・限定的な矛盾を検査するもので、全主張の意味的正しさ、全資料取得、モデルが契約を満たす率を保証しない。通常の再確認は保存応答を使い、未知出典を勝手に許可しない。端末のSafari/IMEの再検証と請求書確定額は未確認。同一要求の再送が既にdone/failedになっている場合、UIが結果不明を表示することがあるが、「進行状況を再確認」から取得でき、追加生成へは進まない。

## ロールバックと保全

フロントの直前基準は `5b018f4de5fe323ca0e0a1a62321fbee3bdba455`。以前のAPIはv37、workerはv21。新しいgenerationがpending/runningの間に旧workerへ戻すと1回限定保護を失うため、その状態では戻さない。必要な場合は新規の有料再生成受付を止め、進行状態を確認してから保護を維持する前進修正または限定復旧を選ぶ。archive・料金行・migration ledgerを削除しない。

仕様は [claim-quotation-recovery.md](claim-quotation-recovery.md)。証跡はHermes scratch `ris-claim-recovery/` のmigration読み戻し、backend-verification、Pages artifact比較、公開合成smoke、私有復旧receipt/statusに分離して保存した。後続docs-onlyコミットは機能コミットを歴史的な基準として保持する。
