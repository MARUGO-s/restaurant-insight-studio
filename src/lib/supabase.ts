import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

export const supabase = createClient(url, publishableKey);

// Supabase Authはメールアドレス形式の識別子を必要とするため、
// ログインIDを専用ドメインの内部アドレスへ対応付ける。
// パスワードはSupabase Auth側だけに保存し、このアプリのコードには含めない。
const loginIdDomain = (import.meta.env.VITE_LOGIN_ID_DOMAIN || "id.restaurant-insight.test").trim().toLowerCase();

export function loginEmailFromId(loginId: string) {
  const id = loginId.trim().toLowerCase();
  return id.includes("@") ? id : `${id}@${loginIdDomain}`;
}

export function displayLoginId(email: string | undefined) {
  if (!email) return "";
  const suffix = `@${loginIdDomain}`;
  return email.toLowerCase().endsWith(suffix) ? email.slice(0, -suffix.length) : email;
}
