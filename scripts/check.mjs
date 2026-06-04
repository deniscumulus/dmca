import { runPortfolioCheck } from "../lib/lumen.mjs";

try {
  const run = await runPortfolioCheck({ source: process.env.CHECK_SOURCE || "scheduled" });
  const lines = [
    `Copyright portfolio check: ${run.status}`,
    `Mode: ${run.mode}`,
    `Domains: ${run.totalDomains}`,
    `New changes: ${run.changeCount}`,
    `Requested URLs: ${run.noticeCount}`,
    `Errors: ${run.errorCount}`,
    `Notification: ${run.notification?.status || "unknown"}`,
    `Run ID: ${run.id}`
  ];

  for (const result of run.results) {
    lines.push(`- ${result.domain}: ${result.status}, ${result.total} requested URL(s)`);
    if (result.error) lines.push(`  ${result.error}`);
    for (const notice of result.notices.slice(0, 5)) {
      lines.push(`  ${notice.isNew ? "NEW " : ""}${notice.id} ${notice.title}`);
      lines.push(`  ${notice.noticeUrl}`);
    }
  }

  console.log(lines.join("\n"));
  process.exit(run.status === "error" ? 1 : 0);
} catch (error) {
  console.error(error.stack || error.message);
  process.exit(1);
}
