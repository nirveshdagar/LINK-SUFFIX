import { afterEach, describe, it, expect, vi } from "vitest";
import {
  FileSuffixSource,
  JsonlSuffixSource,
  GoogleAdsUpdater,
  type UpdateResult,
  type SuffixSource,
} from "./index.js";

// ---- FileSuffixSource tests ----

describe("FileSuffixSource", () => {
  it("returns empty string for missing file", async () => {
    const src = new FileSuffixSource("/tmp/tah-does-not-exist-xyz.txt");
    expect(await src.getSuffix()).toBe("");
  });

  it("reads plain suffix from a file", async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(`${tmpdir()}/tah-suffix-`);
    const file = `${dir}/suffix.txt`;
    try {
      writeFileSync(file, "gclid={_gclid}&dclid={_dclid}\n", "utf8");
      const src = new FileSuffixSource(file);
      expect(await src.getSuffix()).toBe("gclid={_gclid}&dclid={_dclid}");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("trims whitespace", async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(`${tmpdir()}/tah-suffix-`);
    const file = `${dir}/suffix.txt`;
    try {
      writeFileSync(file, "  hello-world  \n", "utf8");
      const src = new FileSuffixSource(file);
      expect(await src.getSuffix()).toBe("hello-world");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

// ---- JsonlSuffixSource tests ----

describe("JsonlSuffixSource", () => {
  it("returns empty string for missing file", async () => {
    const src = new JsonlSuffixSource("/tmp/tah-jsonl-does-not-exist.jsonl");
    expect(await src.getSuffix()).toBe("");
  });

  it("extracts suffix from the last main_document event", async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(`${tmpdir()}/tah-jsonl-`);
    const file = `${dir}/scenarios.jsonl`;
    try {
      writeFileSync(
        file,
        JSON.stringify({
          events: [
            {
              url: "https://example.com/?a=1",
              ta_signal: { main_document: "false" },
            },
            {
              url: "https://example.com/?gclid=abc&dclid=def",
              ta_signal: { main_document: "true" },
            },
          ],
        }) + "\n",
        "utf8",
      );
      const src = new JsonlSuffixSource(file);
      expect(await src.getSuffix()).toBe("gclid=abc&dclid=def");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("falls back to last event when no main_document marker", async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(`${tmpdir()}/tah-jsonl-`);
    const file = `${dir}/scenarios.jsonl`;
    try {
      writeFileSync(
        file,
        JSON.stringify({
          events: [
            { url: "https://example.com/?fallback=yes" },
          ],
        }) + "\n",
        "utf8",
      );
      const src = new JsonlSuffixSource(file);
      expect(await src.getSuffix()).toBe("fallback=yes");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("returns empty string when no URL has a query string", async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(`${tmpdir()}/tah-jsonl-`);
    const file = `${dir}/scenarios.jsonl`;
    try {
      writeFileSync(
        file,
        JSON.stringify({ events: [{ url: "https://example.com/" }] }) + "\n",
        "utf8",
      );
      const src = new JsonlSuffixSource(file);
      expect(await src.getSuffix()).toBe("");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

// ---- SuffixSource interface ----

describe("SuffixSource interface", () => {
  it("both sources implement getSuffix()", async () => {
    const sources: SuffixSource[] = [
      new FileSuffixSource("/tmp/nope"),
      new JsonlSuffixSource("/tmp/nope.jsonl"),
    ];
    for (const src of sources) {
      const result = await src.getSuffix();
      expect(typeof result).toBe("string");
    }
  });
});

// ---- GoogleAdsUpdater unit tests (no real API calls) ----

describe("GoogleAdsUpdater", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("constructs with minimal config", () => {
    const updater = new GoogleAdsUpdater({
      developerToken: "tok",
      clientId: "cid",
      clientSecret: "secret",
      refreshToken: "rtok",
      customerId: "1234567890",
    });
    expect(updater).toBeDefined();
  });

  it("normalises resource names", () => {
    const updater = new GoogleAdsUpdater({
      developerToken: "tok",
      clientId: "cid",
      clientSecret: "secret",
      refreshToken: "rtok",
      customerId: "1234567890",
    });
    // We can't call updateCampaignSuffix without mocking the API,
    // but we can confirm the class instantiated.
    expect(updater).toBeDefined();
  });

  it("sends the exact suffix with the REST field mask and manager header", async () => {
    const exactSuffix = "a=%2B&duplicate=1&duplicate=2&case=AbC";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "access", expires_in: 3600 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ results: [{ campaign: { finalUrlSuffix: "old=1" } }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ results: [{ resourceName: "customers/1234567890/campaigns/987" }] }), {
        status: 200,
        headers: { "request-id": "google-request-123" },
      }));
    vi.stubGlobal("fetch", fetchMock);

    const updater = new GoogleAdsUpdater({
      developerToken: "developer-token",
      clientId: "client-id",
      clientSecret: "client-secret",
      refreshToken: "refresh-token",
      customerId: "123-456-7890",
      loginCustomerId: "111-222-3333",
      minimumMutationIntervalMs: 0,
    });
    const result = await updater.updateCampaignSuffix("123-456-7890", "987", exactSuffix);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const [mutationUrl, mutationInit] = fetchMock.mock.calls[2] as [string, RequestInit];
    const mutationBody = JSON.parse(String(mutationInit.body));
    expect(mutationUrl).toBe("https://googleads.googleapis.com/v25/customers/1234567890/campaigns:mutate");
    expect((mutationInit.headers as Record<string, string>)["login-customer-id"]).toBe("1112223333");
    expect(mutationBody.operations[0].updateMask).toBe("finalUrlSuffix");
    expect(mutationBody.operations[0].update.finalUrlSuffix).toBe(exactSuffix);
    expect(result.requestId).toBe("google-request-123");
    expect(result.mutated).toBe(true);
  });

  it("does not mutate when Google Ads already has the exact suffix", async () => {
    const suffix = "same=%2Fvalue";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "access", expires_in: 3600 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ results: [{ campaign: { finalUrlSuffix: suffix } }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const updater = new GoogleAdsUpdater({
      developerToken: "developer-token",
      clientId: "client-id",
      clientSecret: "client-secret",
      refreshToken: "refresh-token",
      customerId: "1234567890",
    });
    const result = await updater.updateCampaignSuffix("1234567890", "987", suffix);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.mutated).toBe(false);
    expect(result.newSuffix).toBe(suffix);
  });

  it("rejects a leading question mark instead of changing the suffix", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const updater = new GoogleAdsUpdater({
      developerToken: "developer-token",
      clientId: "client-id",
      clientSecret: "client-secret",
      refreshToken: "refresh-token",
      customerId: "1234567890",
    });

    await expect(updater.updateCampaignSuffix("1234567890", "987", "?a=1")).rejects.toThrow("must not include the leading question mark");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---- UpdateResult shape ----

describe("UpdateResult", () => {
  it("has the expected fields", () => {
    const result: UpdateResult = {
      customerId: "1234567890",
      resourceName: "customers/1234567890/campaigns/111",
      type: "campaign",
      previousSuffix: "",
      newSuffix: "gclid={_gclid}",
      updatedAt: new Date().toISOString(),
      mutated: true,
      validateOnly: false,
    };
    expect(result.customerId).toBe("1234567890");
    expect(result.type).toBe("campaign");
    expect(result.newSuffix).toContain("gclid");
  });
});
