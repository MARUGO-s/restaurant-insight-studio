export const reportShareTokenPattern = /^[0-9a-f]{64}$/;

export function newReportShareToken() {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
