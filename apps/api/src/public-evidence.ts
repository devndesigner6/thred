import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { request as httpRequest, type RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";

type Record = { address: string; family: number };
type Resolver = (domain: string) => Promise<Record[]>;
type Requester = typeof httpRequest;
const MAX_BYTES = 128 * 1024;

function publicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a = 0, b = 0, c = 0] = address.split(".").map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0 || b === 2 || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  if (isIP(address) !== 6) return false;
  // Only global unicast; exclude transition mechanisms and special-use allocations.
  const normalized = new URL(`http://[${address}]/`).hostname.slice(1, -1).toLowerCase();
  const first = Number.parseInt(normalized.split(":")[0]!, 16);
  return first >= 0x2000 && first <= 0x3fff && !/^2001:|^2002:|^3fff:/.test(normalized);
}

function parseUrl(value: string): URL {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol))
    throw new Error("Unsupported evidence URL protocol");
  if (url.username || url.password) throw new Error("Evidence URL credentials are forbidden");
  if (url.port) throw new Error("Evidence URL must use the normal protocol port");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) && !publicAddress(host))
    throw new Error("Evidence URL must resolve to public addresses");
  return url;
}

function cleanText(value: string): string {
  return value
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

export function createEvidenceClient(
  resolve: Resolver = (domain) => lookup(domain, { all: true, verbatim: true }),
  request: Requester | undefined = undefined,
) {
  async function lookupPublicDomain(
    domain: string,
  ): Promise<{ domain: string; records: Record[] }> {
    const host = parseUrl(`https://${domain}`).hostname.replace(/^\[|\]$/g, "");
    if (host !== domain.toLowerCase().replace(/^\[|\]$/g, "") || /[/?#@]/.test(domain))
      throw new Error("Invalid public domain");
    const records = isIP(host) ? [{ address: host, family: isIP(host) }] : await resolve(host);
    if (!records.length || records.some((record) => !publicAddress(record.address)))
      throw new Error("Domain must resolve only to public addresses");
    return { domain: host, records };
  }

  async function fetchPublicEvidence(value: string, signal?: AbortSignal) {
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    if (signal?.aborted) abort();
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error("Evidence request timed out")), 8000);
    try {
      return await Promise.race([
        (async () => {
          let url = parseUrl(value);
          for (let redirects = 0; ; redirects++) {
            controller.signal.throwIfAborted();
            const { records } = await lookupPublicDomain(url.hostname);
            controller.signal.throwIfAborted();
            const record = records[0]!;
            const response = await new Promise<{
              status: number;
              location?: string;
              body: string;
              type: string;
            }>((resolveResponse, reject) => {
              const options: RequestOptions = {
                signal: controller.signal,
                agent: false,
                family: record.family,
                headers: {
                  Accept: "text/html, text/plain, application/json",
                  "Accept-Encoding": "identity",
                  "User-Agent": "Thred-Evidence/1.0",
                },
                // Pin the already validated address; never resolve again at connection time.
                lookup: (_hostname, _options, callback) =>
                  callback(null, record.address, record.family),
              };
              const req = (request ?? (url.protocol === "https:" ? httpsRequest : httpRequest))(
                url,
                options,
                (res) => {
                  const status = res.statusCode ?? 0;
                  if ([301, 302, 303, 307, 308].includes(status)) {
                    res.destroy();
                    resolveResponse({ status, location: res.headers.location, body: "", type: "" });
                    return;
                  }
                  const type = String(res.headers["content-type"] ?? "")
                    .split(";")[0]!
                    .trim()
                    .toLowerCase();
                  if (
                    !["text/html", "text/plain", "application/json"].includes(type) ||
                    (res.headers["content-encoding"] &&
                      res.headers["content-encoding"] !== "identity")
                  ) {
                    reject(new Error("Unsupported evidence content type or encoding"));
                    res.destroy();
                    return;
                  }
                  let bytes = 0;
                  const chunks: Buffer[] = [];
                  res.on("data", (chunk: Buffer) => {
                    bytes += chunk.length;
                    if (bytes > MAX_BYTES) {
                      reject(new Error("Evidence response exceeds 128 KiB limit"));
                      res.destroy();
                    } else chunks.push(chunk);
                  });
                  res.on("error", reject);
                  res.on("aborted", () => reject(new Error("Evidence response was interrupted")));
                  res.on("end", () =>
                    resolveResponse({ status, body: Buffer.concat(chunks).toString("utf8"), type }),
                  );
                },
              );
              req.on("error", reject);
              req.end();
            });
            if ([301, 302, 303, 307, 308].includes(response.status)) {
              if (!response.location || redirects >= 3)
                throw new Error("Evidence redirect limit exceeded or missing location");
              url = parseUrl(new URL(response.location, url).href);
              continue;
            }
            if (response.status < 200 || response.status >= 300)
              throw new Error(`Evidence returned HTTP ${response.status}`);
            const html = response.type === "text/html";
            const title = html
              ? cleanText(
                  response.body.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "",
                ).slice(0, 300) || null
              : null;
            const body = html
              ? response.body.replace(
                  /<(script|style|nav|header|footer)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,
                  " ",
                )
              : response.body;
            const main = html
              ? (body.match(/<(?:main|article)\b[^>]*>([\s\S]*?)<\/(?:main|article)>/i)?.[1] ??
                body)
              : body;
            const text = html ? cleanText(main) : main.replace(/\s+/g, " ").trim();
            return {
              url: url.href,
              status: response.status,
              title,
              excerpt: text.length > 6000 ? `${text.slice(0, 6000)} [excerpt truncated]` : text,
            };
          }
        })(),
        new Promise<never>((_resolve, reject) => {
          if (controller.signal.aborted) reject(controller.signal.reason);
          else
            controller.signal.addEventListener("abort", () => reject(controller.signal.reason), {
              once: true,
            });
        }),
      ]);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }
  return { fetchPublicEvidence, lookupPublicDomain };
}

export const { fetchPublicEvidence, lookupPublicDomain } = createEvidenceClient();
