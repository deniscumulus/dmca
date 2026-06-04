import { existsSync } from "node:fs";
import { chromium } from "playwright";

const noticeUrl = process.argv[2];
const targetDomain = process.argv[3] || "";

if (!noticeUrl || !/^https?:\/\/(?:www\.)?lumendatabase\.org\/notices\//i.test(noticeUrl)) {
  console.error("Usage: node scripts/test-lumen-notice.mjs https://lumendatabase.org/notices/123 domain.com");
  process.exit(1);
}

const browser = await chromium.launch({
  headless: process.env.HEADLESS === "false" ? false : true,
  executablePath: findLocalBrowserExecutable()
});

try {
  const page = await browser.newPage({
    viewport: { width: 1360, height: 1000 },
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
  });
  page.setDefaultTimeout(45000);

  let navigationError = "";
  try {
    await page.goto(noticeUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(Number(process.env.LUMEN_WAIT_MS || 20000));
  } catch (error) {
    navigationError = cleanError(error);
  }

  const data = await page.evaluate((domain) => {
    const text = document.body?.innerText?.replace(/\s+/g, " ").trim() || "";
    const urls = Array.from(
      new Set(
        Array.from(text.matchAll(/https?:\/\/[^\s<>"')]+/gi)).map((match) =>
          match[0].replace(/[.,;]+$/, "")
        )
      )
    );
    const targetUrls = urls.filter((url) => {
      if (!domain) return false;
      try {
        return new URL(url).hostname.replace(/^www\./, "") === domain.replace(/^www\./, "");
      } catch {
        return false;
      }
    });

    return {
      title: document.title,
      finalUrl: location.href,
      textSample: text.slice(0, 1200),
      allUrlCount: urls.length,
      targetUrlCount: targetUrls.length,
      targetUrls: targetUrls.slice(0, 50),
      hasAnubis: /Anubis|Making sure you.re not a bot|proof-of-work|enable JavaScript/i.test(text),
      hasAccessText: /request access|full URLs|see full urls|hidden|redacted/i.test(text)
    };
  }, targetDomain);

  const noticeId = noticeUrl.match(/\/notices\/(\d+)/)?.[1] || "notice";
  const screenshot = `screenshots/lumen-notice-${noticeId}-test.png`;
  await page.screenshot({ path: screenshot, fullPage: true }).catch(() => {});

  console.log(
    JSON.stringify(
      {
        noticeUrl,
        targetDomain,
        navigationError,
        screenshot,
        ...data
      },
      null,
      2
    )
  );
} finally {
  await browser.close().catch(() => {});
}

function findLocalBrowserExecutable() {
  const candidates = [
    process.env.BROWSER_EXECUTABLE_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"
  ].filter(Boolean);

  return candidates.find((candidate) => existsSync(candidate));
}

function cleanError(error) {
  return String(error?.message || error || "")
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
