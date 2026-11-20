import { createRoot } from "react-dom/client";
import { SharedReportPage, shareTokenFromFragment } from "./SharedReportView";
import "./style.css";
import "./shared-report.css";

const root = createRoot(document.getElementById("root")!);
function render() {
  document.title = "店舗分析レポート";
  const token = shareTokenFromFragment(window.location.hash);
  root.render(<SharedReportPage key={token ?? "unavailable"} baseUrl={import.meta.env.VITE_SUPABASE_URL} token={token}/>);
}
window.addEventListener("hashchange", render);
render();
