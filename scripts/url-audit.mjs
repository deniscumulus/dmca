import { runUrlDeepScan } from "../lib/url-audit.mjs";

try {
  const maxUrlsPerDomain = process.env.URL_AUDIT_MAX_URLS_PER_DOMAIN
    ? Number(process.env.URL_AUDIT_MAX_URLS_PER_DOMAIN)
    : undefined;
  const run = await runUrlDeepScan({
    source: process.env.CHECK_SOURCE || "manual",
    maxUrlsPerDomain
  });
  const lines = [
    `URL deep scan: ${run.status}`,
    `Domains: ${run.totalDomains}`,
    `URLs: ${run.totalUrls}`,
    `Indexed: ${run.indexedCount}`,
    `Possible removal signals: ${run.possibleRemovalCount}`,
    `Not found: ${run.notFoundCount}`,
    `Blocked: ${run.blockedCount}`,
    `Errors: ${run.errorCount}`,
    `Run ID: ${run.id}`
  ];

  for (const domain of run.domains) {
    lines.push(
      `- ${domain.domain}: ${domain.status}, ${domain.scannedUrls}/${domain.discoveredUrls} URL(s) scanned`
    );
    for (const result of domain.results.filter((item) => item.status !== "indexed").slice(0, 8)) {
      lines.push(`  ${result.status}: ${result.url}`);
      if (result.signal || result.error) lines.push(`  ${result.signal || result.error}`);
    }
  }

  console.log(lines.join("\n"));
  process.exit(run.status === "error" ? 1 : 0);
} catch (error) {
  console.error(error.stack || error.message);
  process.exit(1);
}
