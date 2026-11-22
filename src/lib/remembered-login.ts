export const REMEMBERED_LOGIN_KEY = "restaurant-insight.remembered-login";

export type RememberedLogin = { loginId: string; password: string };

type StorageLike = { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void };

function currentStorage(explicit?: StorageLike | null): StorageLike | null {
  if (explicit !== undefined) return explicit;
  try { return typeof localStorage === "undefined" ? null : localStorage; } catch { return null; }
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary);
}

function base64ToBytes(value: string) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function mask(bytes: Uint8Array) {
  const key = 0x5a;
  return bytes.map((byte, index) => byte ^ key ^ (index & 0xff));
}

export function obfuscateRememberedLogin(login: RememberedLogin) {
  const encoded = new TextEncoder().encode(JSON.stringify({ v: 1, loginId: login.loginId, password: login.password }));
  return bytesToBase64(mask(encoded));
}

export function revealRememberedLogin(value: string): RememberedLogin | null {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(mask(base64ToBytes(value)))) as { loginId?: unknown; password?: unknown };
    if (typeof parsed?.loginId !== "string" || typeof parsed?.password !== "string" || !parsed.loginId.trim() || !parsed.password) return null;
    return { loginId: parsed.loginId, password: parsed.password };
  } catch {
    return null;
  }
}

export function loadRememberedLogin(storage?: StorageLike | null): RememberedLogin | null {
  try {
    const raw = currentStorage(storage)?.getItem(REMEMBERED_LOGIN_KEY);
    return raw ? revealRememberedLogin(raw) : null;
  } catch {
    return null;
  }
}

export function saveRememberedLogin(loginId: string, password: string, storage?: StorageLike | null) {
  const login = { loginId: loginId.trim(), password };
  if (!login.loginId || !login.password) {
    clearRememberedLogin(storage);
    return;
  }
  try { currentStorage(storage)?.setItem(REMEMBERED_LOGIN_KEY, obfuscateRememberedLogin(login)); } catch { /* ignore quota / private mode */ }
}

export function clearRememberedLogin(storage?: StorageLike | null) {
  try { currentStorage(storage)?.removeItem(REMEMBERED_LOGIN_KEY); } catch { /* ignore */ }
}

export function rememberedLoginMatches(loginId: string, password: string, storage?: StorageLike | null) {
  const saved = loadRememberedLogin(storage);
  return !!saved && saved.loginId.trim() === loginId.trim() && saved.password === password;
}

export async function offerBrowserPasswordSave(loginId: string, password: string) {
  const CredentialCtor = (globalThis as typeof globalThis & { PasswordCredential?: new (data: { id: string; password: string; name?: string }) => Credential }).PasswordCredential;
  if (typeof CredentialCtor !== "function" || !navigator.credentials?.store || !loginId.trim() || !password) return;
  try {
    await navigator.credentials.store(new CredentialCtor({ id: loginId.trim(), password, name: loginId.trim() }));
  } catch {
    /* unsupported, or the browser declined to store */
  }
}
