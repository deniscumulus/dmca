import net from "node:net";
import tls from "node:tls";
import { loadConfig, getSmtpSettings } from "./store.mjs";

export async function maybeSendRunNotification(run) {
  const config = await loadConfig();
  if (!config.emailAlertsEnabled) {
    return { attempted: false, status: "disabled" };
  }

  const shouldNotify = run.changeCount > 0 || run.errorCount > 0;
  if (!shouldNotify) {
    return { attempted: false, status: "no_changes" };
  }

  const smtp = getSmtpSettings(config);
  if (!smtp.configured) {
    return {
      attempted: false,
      status: "missing_smtp",
      error: "Email alerts need SMTP_HOST, SMTP_FROM, and a notification email."
    };
  }

  const subject =
    run.changeCount > 0
      ? `[Copyright Monitor] ${run.changeCount} new change(s)`
      : "[Copyright Monitor] Check errors";
  const body = buildDigest(run);
  await sendSmtpMail(smtp, { subject, body });
  return { attempted: true, status: "sent", to: smtp.to };
}

export async function maybeSendLumenClaimsNotification(run) {
  const config = await loadConfig();
  if (!config.emailAlertsEnabled) {
    return { attempted: false, status: "disabled" };
  }

  const newNoticeCount = Number(run.newNoticeCount || 0);
  const shouldNotify = newNoticeCount > 0 || Number(run.errorCount || 0) > 0;
  if (!shouldNotify) {
    return { attempted: false, status: "no_new_claims" };
  }

  const smtp = getSmtpSettings(config);
  if (!smtp.configured) {
    return {
      attempted: false,
      status: "missing_smtp",
      error: "Email alerts need SMTP_HOST, SMTP_FROM, and a notification email."
    };
  }

  const subject =
    newNoticeCount > 0
      ? `[DMCA Claims Queue] ${newNoticeCount} new claim(s)`
      : "[DMCA Claims Queue] Scan errors";
  const body = buildLumenClaimsDigest(run);
  await sendSmtpMail(smtp, { subject, body });
  return { attempted: true, status: "sent", to: smtp.to };
}

function buildDigest(run) {
  const lines = [
    "Copyright Portfolio Monitor",
    "",
    `Run: ${run.id}`,
    `Mode: ${run.mode}`,
    `Started: ${run.startedAt}`,
    `Domains: ${run.totalDomains}`,
    `Requested URLs: ${run.noticeCount}`,
    `New changes: ${run.changeCount}`,
    `Errors: ${run.errorCount}`,
    ""
  ];

  for (const result of run.results) {
    const newCount = result.notices.filter((notice) => notice.isNew).length;
    if (newCount === 0 && result.status !== "error") continue;

    lines.push(`${result.domain}: ${newCount} new, ${result.total} total`);
    if (result.error) lines.push(`Error: ${result.error}`);
    for (const notice of result.notices.filter((item) => item.isNew)) {
      lines.push(`- ${notice.title}`);
      lines.push(`  ${notice.noticeUrl}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function buildLumenClaimsDigest(run) {
  const lines = [
    "DMCA Claims Queue",
    "",
    `Run: ${run.id}`,
    `Started: ${run.startedAt}`,
    `Domains checked: ${run.checkedDomains}/${run.totalDomains}`,
    `New claims: ${run.newNoticeCount || 0}`,
    `Total claims in this run: ${run.noticeCount || 0}`,
    `Claimed URLs in this run: ${run.targetDomainUrlCount || 0}`,
    `Errors: ${run.errorCount || 0}`,
    ""
  ];

  const newNotices = Array.isArray(run.newNotices) ? run.newNotices : [];
  if (newNotices.length > 0) {
    lines.push("New claims:");
    for (const notice of newNotices) {
      lines.push(
        `- ${notice.domain}: notice ${notice.noticeId || "-"}, request ${notice.requestId || "-"}, URLs ${notice.targetDomainUrls || 0}`
      );
      if (notice.lumenUrl) lines.push(`  Lumen: ${notice.lumenUrl}`);
      if (notice.requestAccessUrl) lines.push(`  Request full URLs: ${notice.requestAccessUrl}`);
      if (notice.googleRequestUrl) lines.push(`  Google request: ${notice.googleRequestUrl}`);
    }
    lines.push("");
  }

  const errorDomains = (run.domains || []).filter((domain) => domain.status === "error");
  if (errorDomains.length > 0) {
    lines.push("Errors:");
    for (const domain of errorDomains) {
      lines.push(`- ${domain.domain}: ${domain.error || "Unknown error"}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

async function sendSmtpMail(settings, message) {
  const client = await SmtpClient.connect(settings);
  try {
    await client.ehlo();
    if (!settings.secure) {
      await client.startTlsIfAvailable(settings.host);
      await client.ehlo();
    }
    if (settings.user && settings.pass) {
      await client.auth(settings.user, settings.pass);
    }
    await client.mail(settings.from, settings.to, message);
    await client.quit();
  } finally {
    client.close();
  }
}

class SmtpClient {
  static connect(settings) {
    return new Promise((resolve, reject) => {
      const socket = settings.secure
        ? tls.connect(settings.port, settings.host, { servername: settings.host })
        : net.connect(settings.port, settings.host);
      const client = new SmtpClient(socket);

      socket.once("error", reject);
      client
        .readResponse()
        .then(() => resolve(client))
        .catch(reject);
    });
  }

  constructor(socket) {
    this.socket = socket;
    this.buffer = "";
    this.waiters = [];
    this.closed = false;

    socket.on("data", (chunk) => {
      this.buffer += chunk.toString("utf8");
      this.flushWaiters();
    });
  }

  async ehlo() {
    await this.command(`EHLO localhost`);
  }

  async startTlsIfAvailable(host) {
    const response = await this.command("STARTTLS", [220, 454, 500, 502]);
    if (!response.startsWith("220")) return;

    this.socket = tls.connect({ socket: this.socket, servername: host });
    this.buffer = "";
    await new Promise((resolve, reject) => {
      this.socket.once("secureConnect", resolve);
      this.socket.once("error", reject);
    });
    this.socket.on("data", (chunk) => {
      this.buffer += chunk.toString("utf8");
      this.flushWaiters();
    });
  }

  async auth(user, pass) {
    await this.command("AUTH LOGIN", [334]);
    await this.command(Buffer.from(user).toString("base64"), [334]);
    await this.command(Buffer.from(pass).toString("base64"), [235]);
  }

  async mail(from, to, message) {
    await this.command(`MAIL FROM:<${from}>`);
    await this.command(`RCPT TO:<${to}>`);
    await this.command("DATA", [354]);
    const payload = [
      `From: ${from}`,
      `To: ${to}`,
      `Subject: ${message.subject}`,
      "Content-Type: text/plain; charset=utf-8",
      "",
      message.body.replace(/\r?\n\./g, "\n.."),
      "."
    ].join("\r\n");
    await this.command(payload);
  }

  async quit() {
    await this.command("QUIT", [221]);
  }

  close() {
    if (!this.closed) {
      this.closed = true;
      this.socket.destroy();
    }
  }

  command(value, accepted = [250]) {
    this.socket.write(`${value}\r\n`);
    return this.readResponse().then((response) => {
      if (!accepted.some((code) => response.startsWith(String(code)))) {
        throw new Error(`SMTP error: ${response.replace(/\s+/g, " ").trim()}`);
      }
      return response;
    });
  }

  readResponse() {
    return new Promise((resolve) => {
      this.waiters.push(resolve);
      this.flushWaiters();
    });
  }

  flushWaiters() {
    const response = this.extractResponse();
    if (!response) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter(response);
  }

  extractResponse() {
    const lines = this.buffer.split(/\r?\n/);
    if (lines.length < 2) return null;

    let endIndex = -1;
    for (let index = 0; index < lines.length - 1; index += 1) {
      if (/^\d{3}\s/.test(lines[index])) {
        endIndex = index;
        break;
      }
    }

    if (endIndex === -1) return null;
    const response = lines.slice(0, endIndex + 1).join("\n");
    this.buffer = lines.slice(endIndex + 1).join("\n");
    return response;
  }
}
