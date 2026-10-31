import { supabase } from "./supabase";

export async function invoke<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke("restaurant-analysis", { body });
  if (error) {
    const context = (error as { context?: unknown }).context;
    if (context instanceof Response) {
      const result = await context.clone().json().catch(() => ({}));
      throw new Error(typeof result?.error === "string" ? result.error : error.message);
    }
    throw new Error(error.message || "Supabase Edge Functionに接続できませんでした");
  }
  return data as T;
}
