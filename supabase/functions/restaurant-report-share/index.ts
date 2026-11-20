import { handlePublicReportShare } from "./handler.ts";

Deno.serve((request) => handlePublicReportShare(request));
