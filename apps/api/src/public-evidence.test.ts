import { test } from "node:test";
import assert from "node:assert/strict";
import { createEvidenceClient } from "./public-evidence.js";
import { createServer, request, type RequestOptions } from "node:http";
import type { AddressInfo } from "node:net";

test("rejects private, encoded, reserved, and mixed DNS targets before requesting", async () => {
  for (const address of [
    "127.0.0.1",
    "10.0.0.1",
    "169.254.169.254",
    "192.0.2.1",
    "::1",
    "::ffff:7f00:1",
    "fc00::1",
    "2001:db8::1",
  ]) {
    const client = createEvidenceClient(async () => [
      { address, family: address.includes(":") ? 6 : 4 },
    ]);
    await assert.rejects(client.fetchPublicEvidence("https://example.com"), /public/i);
  }
  const mixed = createEvidenceClient(async () => [
    { address: "8.8.8.8", family: 4 },
    { address: "127.0.0.1", family: 4 },
  ]);
  await assert.rejects(mixed.lookupPublicDomain("example.com"), /public/i);
});

test("pins DNS, revalidates redirects, extracts content and enforces streamed byte limit", async () => {
  const server = createServer((req, res) => {
    if (req.url === "/redirect") {
      res.writeHead(302, { location: "http://127.0.0.1/" });
      res.end();
      return;
    }
    res.setHeader("Content-Type", "text/html");
    if (req.url === "/large") {
      res.end("x".repeat(128 * 1024 + 1));
      return;
    }
    res.end(
      "<title>Page</title><nav>Ignore</nav><main>Hello <b>world</b><script>secret()</script></main>",
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  let lookups = 0;
  let requests = 0;
  const transport: typeof request = ((
    url: URL,
    options: RequestOptions,
    callback: Parameters<typeof request>[2],
  ) => {
    requests++;
    const pinned = options.lookup! as Function;
    pinned(url.hostname, {}, (error: Error | null, address: string, family: number) => {
      assert.equal(error, null);
      assert.equal(address, "8.8.8.8");
      assert.equal(family, 4);
    });
    return request(
      new URL(url.pathname, `http://127.0.0.1:${(server.address() as AddressInfo).port}`),
      { ...options, lookup: undefined },
      callback,
    );
  }) as typeof request;
  const client = createEvidenceClient(async () => {
    lookups++;
    return [{ address: "8.8.8.8", family: 4 }];
  }, transport);
  try {
    assert.deepEqual(await client.fetchPublicEvidence("http://example.com/"), {
      url: "http://example.com/",
      status: 200,
      title: "Page",
      excerpt: "Hello world",
    });
    assert.equal(lookups, 1);
    await assert.rejects(client.fetchPublicEvidence("http://example.com/redirect"), /public/i);
    assert.equal(requests, 2);
    await assert.rejects(client.fetchPublicEvidence("http://example.com/large"), /128 KiB/);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("rejects credentials, custom ports, unsupported protocols and encoded loopback", async () => {
  const client = createEvidenceClient(async () => {
    throw new Error("DNS must not run");
  });
  for (const url of [
    "https://user:pass@example.com",
    "http://example.com:8080",
    "file:///etc/passwd",
    "http://2130706433",
    "http://[::ffff:127.0.0.1]",
  ]) {
    await assert.rejects(client.fetchPublicEvidence(url), /public|port|credential|protocol/i);
  }
});
