import fs from "node:fs/promises";
import { FileBlob, SpreadsheetFile } from "@oai/artifact-tool";

const inputPath = process.argv[2];
if (!inputPath) {
  throw new Error("Usage: node scripts/extract-sites.mjs <workbook.xlsx>");
}

const blob = await FileBlob.load(inputPath);
const workbook = await SpreadsheetFile.importXlsx(blob);

const preview = await workbook.inspect({
  kind: "workbook,sheet,table",
  maxChars: 12000,
  tableMaxRows: 20,
  tableMaxCols: 12,
  tableMaxCellChars: 120
});

const valuesText = await collectWorkbookText(workbook);
const domains = extractDomains(valuesText || preview.ndjson);
const output = {
  count: domains.length,
  domains,
  inspectPreview: preview.ndjson
};

await fs.writeFile("data/import-preview.json", `${JSON.stringify(output, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ count: domains.length, domains: domains.slice(0, 20) }, null, 2));

function extractDomains(text) {
  const matches = new Set();
  const urlPattern =
    /(?:https?:\/\/)?(?:www\.)?[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+(?:\/[^\s"',<>]*)?/gi;
  const skip = new Set([
    "example.com",
    "lumendatabase.org",
    "schema.openxmlformats.org",
    "schemas.microsoft.com"
  ]);

  for (const match of text.matchAll(urlPattern)) {
    const domain = normalizeDomain(match[0]);
    if (!domain || skip.has(domain)) continue;
    if (!domain.includes(".")) continue;
    matches.add(domain);
  }

  return Array.from(matches).sort((a, b) => a.localeCompare(b));
}

async function collectWorkbookText(workbook) {
  const fragments = [];

  for (let index = 0; index < 50; index += 1) {
    let sheet;
    try {
      sheet = workbook.worksheets.getItemAt(index);
    } catch {
      break;
    }

    if (!sheet) break;

    try {
      const usedRange = sheet.getUsedRange(true);
      fragments.push(JSON.stringify(usedRange.values));
    } catch {
      const sheetInfo = await workbook.inspect({
        kind: "table",
        sheetId: sheet.name,
        maxChars: 200000,
        tableMaxRows: 10000,
        tableMaxCols: 50,
        tableMaxCellChars: 200
      });
      fragments.push(sheetInfo.ndjson);
    }
  }

  return fragments.join("\n");
}

function normalizeDomain(value) {
  const raw = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^[("'`]+|[)"'`,.;:]+$/g, "");

  if (!raw) return "";
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;

  try {
    const parsed = new URL(withScheme);
    return parsed.hostname.replace(/^www\./, "").replace(/\.$/, "");
  } catch {
    return raw
      .replace(/^https?:\/\//, "")
      .replace(/^www\./, "")
      .split("/")[0]
      .split(":")[0]
      .replace(/\.$/, "");
  }
}
