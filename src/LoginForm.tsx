import type { FormEvent } from "react";

export type LoginFormProps = {
  loginId: string;
  password: string;
  rememberLogin: boolean;
  hasRememberedLogin: boolean;
  signingIn: boolean;
  error: string;
  onLoginIdChange: (value: string) => void;
  onPasswordChange: (value: string) => void;
  onRememberChange: (checked: boolean) => void;
  onClearRemembered: () => void;
  onSubmit: (event: FormEvent) => void;
};

export function LoginForm({
  loginId, password, rememberLogin, hasRememberedLogin, signingIn, error,
  onLoginIdChange, onPasswordChange, onRememberChange, onClearRemembered, onSubmit,
}: LoginFormProps) {
  return <main className="auth-screen">
    <div className="auth-card">
      <a className="brand auth-brand" href="#top"><span className="brand-mark">R</span><span><b>Restaurant</b><small>INSIGHT STUDIO</small></span></a>
      <span className="eyebrow">PRIVATE RESEARCH WORKSPACE</span>
      <h1>ログイン</h1>
      <p>IDとパスワードでログインします。レポートはアカウントごとに分離して保存されます。</p>
      <form id="login-form" method="post" action="#" autoComplete="on" onSubmit={onSubmit}>
        <label htmlFor="login-id">ID
          <input id="login-id" required type="text" name="username" autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck={false} value={loginId} onChange={(event) => onLoginIdChange(event.target.value)} placeholder="ID"/>
        </label>
        <label className="auth-password" htmlFor="login-password">パスワード
          <input id="login-password" required type="password" name="password" autoComplete="current-password" value={password} onChange={(event) => onPasswordChange(event.target.value)} placeholder="パスワード"/>
        </label>
        <div className="auth-remember-row">
          <label className="auth-remember">
            <input type="checkbox" name="remember-login" checked={rememberLogin} onChange={(event) => onRememberChange(event.target.checked)}/>
            <span>IDとパスワードをこの端末に記録する</span>
          </label>
          {hasRememberedLogin && <button type="button" className="text-button auth-remember-clear" onClick={onClearRemembered}>記録を削除</button>}
        </div>
        <button className="primary-button" type="submit" disabled={signingIn}>{signingIn ? "ログイン中…" : "ログイン"}</button>
      </form>
      {error && <div className="error-banner">{error}</div>}
      <small className="auth-security">パスワードはSupabase Authで管理されます。記録をオンにすると、この端末のブラウザに保存されます。共用の端末ではオフにしてください。</small>
    </div>
  </main>;
}
