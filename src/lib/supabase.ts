import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

export const supabase = createClient(url, publishableKey);
export const authRedirectUrl = () => new URL(import.meta.env.BASE_URL, window.location.origin).href;
