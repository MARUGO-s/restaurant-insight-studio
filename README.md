# Restaurant Insight Studio

独立した飲食店リサーチアプリです。`review_dashboard`等の既存画面とは独立したUI・処理・テーブルを持ちます。バックエンドはSupabase project `gourmet`の認証とEdge Functionを利用します。

## Data isolation and secrets

- 保存先はこのアプリ専用の`restaurant_insight_reports`、`restaurant_insight_followups`、`restaurant_insight_runs`、`restaurant_insight_jobs`、`restaurant_insight_cost_events`です。既存の`ai_reports`、`ai_usage`を含む他アプリのテーブルは読み書きしません。
- 全テーブルでRLSを有効にします。ユーザー向けAPIはJWT認証し、自分のレポート・利用量・進行状況だけを返します。ジョブ本体はservice_role専用で、ブラウザーから直接参照・更新できません。
- OpenAI、Gemini、xAIのAPIキーはSupabase Dashboardの **Edge Functions → Secrets** に`OPENAI_API_KEY`、`GEMINI_API_KEY`、`XAI_API_KEY`として登録します。APIキー用のDBテーブルは作りません。関数実行環境だけが値を読み、ブラウザーやレポート行には返しません。
- 1ユーザーあたりの分析開始は1時間10回までに制限し、実行状態を`restaurant_insight_runs`へ記録します。
- `restaurant_insight_cost_events`には各プロバイダーAPI応答が返す利用量を呼び出し単位で保存します。画面ではモデルごとの公式公開単価とツール利用料から標準料金ベースのUSD積算を表示します。各社の無料枠・契約割引・税・為替をAPI応答から特定できないため、請求書の確定額とは区別します。利用量やモデル単価を取得できない呼び出しは算定不能と表示します。
- OpenAIの分析、反証、統合、質問回答には`gpt-6.1-terra`を使います。Geminiは`gemini-3.8-flash`、xAIは`grok-4.7`を既定値とし、呼び出しで実際に使ったモデルIDと料金スナップショットも保存します。

## Local development

```sh
npm install
cp .env.example .env.local
npm run dev
```

ローカルURLは`http://localhost:5173/restaurant-insight-studio/`です。

## ログイン

IDとパスワードでログインします（Supabase Authの`signInWithPassword`）。Supabase Authはメールアドレス形式の識別子を必要とするため、`@`を含まないIDは`<ID>@id.restaurant-insight.test`へ変換して照合します（ドメインは`VITE_LOGIN_ID_DOMAIN`で変更可能）。`.test`は予約済みのドメインで、実在のメールボックスには届きません。`@`を含む入力はメールアドレスとしてそのまま使います。

パスワードはSupabase Auth側だけに保存し、ソースコード・`.env`・ビルド成果物には含めません。アカウントはSupabase Dashboard → Authentication → Users → Add user → Create new user で、Emailに`<ID>@id.restaurant-insight.test`、Passwordを入力し、Auto Confirm Userを有効にして作成します。パスワードの変更も同じ画面で行います。

レポート・料金・ゴミ箱はSupabaseのユーザーIDごとに分離されるため、以前のメールリンク用アカウントで作ったレポートは新しいIDアカウントには表示されません。

2026-11-01公開：23店舗の選択・自由入力と公式サイト／食べログURL連動、レポート品質v3を反映済み。検証・配布証跡・制限は[公開記録](docs/release-2026-11-01.md)を参照。

## Deployment checklist

1. `supabase/migrations/`の未適用分を確認し、このアプリのmigrationだけを`gourmet`へ適用します。共有DBへの一括db pushは使いません。永続ジョブmigrationはpg_cron / pg_netを有効化し、専用dispatcherを毎分実行します。
2. `restaurant-analysis`を`verify_jwt = true`、`restaurant-analysis-worker`を`verify_jwt = false`で配置します。両方に依存ファイル`restaurant-analysis/core.ts`を含めます。workerはDBが発行する256bit・120秒有効・1回限りのジョブ別トークンをservice専用RPCで照合します。匿名リクエストだけでは処理を開始できません。既存のユーザーAPIのJWT認証は維持します。
3. Supabase Dashboard → Edge Functions → Secretsに3社のAPIキーを設定します。`.env.local`にはSupabaseの公開キーだけを置き、AI APIキーは置きません。
4. Supabase Security Advisorsを確認し、このアプリの権限を検証します。jobsはRLS有効・ユーザー向けpolicyなしが意図した設定です。

pg_netの`net`スキーマはData APIに公開しないでください。2026-10-31の検証ではRESTの公開対象外で、匿名・認証ユーザーがdispatcherを実行する権限もありません。管理対象のpg_netテーブルは`supabase_admin`所有のため、追加のREVOKE migrationだけではACLは変更されませんでした。トークンの保護をこのREVOKEの成功に依存させず、スキーマ非公開・短い有効期限・単一ジョブへの束縛・一度限りの使用を維持します。

検索はOpenAI Web Search、Gemini Google Search、xAI X Searchを使います。3社すべての調査完了を必須とし、GeminiからOpenAIへの自動代替は行いません。各社の利用料金が発生します。

「API料金」の「Gemini接続確認」から、調査と同じキー・モデルの応答を確認できます。短い診断リクエストも料金明細へ記録し、Googleが返した利用枠の指標・上限・対象モデル等を表示します。キー本体は返さず、末尾だけでAI Studioのキーと照合できます。

## 長時間調査

4つの調査工程（市場・媒体・X最近・X過去）と統合を独立実行し、結果をDBへ保存します。Xは各300秒・3回まで、総API処理枠30分。全体待機45分。調査工程自体が失敗した状態では完成レポートとして保存せず、完了済みを保持したまま未完了工程だけを再開できます。調査が完了しても個別ページが閲覧不能だった場合や該当投稿が見つからなかった場合は、その限界をレポートに明記します。料金イベントはAPI送信前に作り、通信断やworker終了時も「未算定」の試行を残します。正常応答の利用量で同じ行を更新し、二重加算しません。

詳しいレポート形式と検証は[docs/report-format.md](docs/report-format.md)を参照してください。

## レポートのゴミ箱

保存したレポートのゴミ箱ボタンで移動し、サイドバーの「ゴミ箱」から復元または完全削除します。自動削除は行いません。完全削除はゴミ箱内のレポートだけを対象に、作成日時と店舗名を確認して実行します。

完全削除はレポート本文・専門調査・質問履歴・ジョブ内の調査コピー・実行時の入力を同一トランザクションで消去します。API利用量と料金、店舗名・作成日時、および再送を安全に処理するための本文を含まない削除記録は保持します。削除記録のテーブルはRLS有効かつユーザー向け権限なしです。操作RPCはservice_role専用で、Edge Functionが検証した所有者IDに限定して処理します。

`supabase/tests/restaurant_insight_report_trash.sql` は全データをロールバックする検証で、所有者分離・ゴミ箱経由・復元・完全削除・料金保持・遅延処理による復活防止を確認します。`supabase/tests/report_trash_test.ts` は確認フラグ、ページ送り、削除後の料金更新、ゴミ箱内レポートへの質問拒否を確認します。

## GitHub deployment

- Repository: https://github.com/MARUGO-s/restaurant-insight-studio
- App: https://marugo-s.github.io/restaurant-insight-studio/
- Pushes to main run build and report rendering checks, then deploy GitHub Pages.
- Supabase functions and data are hosted separately in the existing gourmet project.
- AI keys, local environment files, and private report data are excluded from Git.
