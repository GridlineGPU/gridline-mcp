import { describe, expect, test } from "bun:test";
import {
  configFromEnv,
  createClient,
  DEFAULT_BASE_URL,
  type FetchLike,
  GridlineApiError,
  scrub,
  seg,
} from "./client.ts";

const TOKEN = "glk_test_0123456789abcdef";

type Call = { url: string; init: RequestInit };
function recorder(answer: (call: Call) => Response): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    fetch: async (url, init = {}) => {
      const call = { url, init };
      calls.push(call);
      return answer(call);
    },
  };
}

describe("configFromEnv", () => {
  test("needs GRIDLINE_TOKEN; the refusal never echoes anything secret", () => {
    const missing = configFromEnv({});
    expect(missing).toEqual({ error: expect.stringContaining("GRIDLINE_TOKEN") });
    expect(configFromEnv({ GRIDLINE_TOKEN: "   " })).toHaveProperty("error");
  });

  test("defaults to the public API and trims a trailing slash", () => {
    const config = configFromEnv({ GRIDLINE_TOKEN: TOKEN });
    expect("error" in config).toBe(false);
    if (!("error" in config)) expect(config.baseUrl).toBe(DEFAULT_BASE_URL);
    const custom = configFromEnv({
      GRIDLINE_TOKEN: TOKEN,
      GRIDLINE_BASE_URL: "https://example.test/openai/v1/",
    });
    if (!("error" in custom)) expect(custom.baseUrl).toBe("https://example.test/openai/v1");
  });

  test("refuses a non-https base URL except localhost, so the key is never sent in clear text", () => {
    expect(
      configFromEnv({ GRIDLINE_TOKEN: TOKEN, GRIDLINE_BASE_URL: "http://example.test/v1" }),
    ).toEqual({ error: "GRIDLINE_BASE_URL must be an https URL." });
    expect(configFromEnv({ GRIDLINE_TOKEN: TOKEN, GRIDLINE_BASE_URL: "not a url" })).toEqual({
      error: "GRIDLINE_BASE_URL is not a URL.",
    });
    expect(
      "error" in
        configFromEnv({ GRIDLINE_TOKEN: TOKEN, GRIDLINE_BASE_URL: "http://localhost:8787" }),
    ).toBe(false);
  });
});

describe("createClient", () => {
  test("sends the key only as a Bearer Authorization header", async () => {
    const { fetch, calls } = recorder(() => Response.json({ object: "list", data: [] }));
    const client = createClient({ token: TOKEN, baseUrl: DEFAULT_BASE_URL, fetch });
    await client.get("/models", { limit: 5, after: undefined });
    expect(calls).toHaveLength(1);
    const call = calls[0] as Call;
    expect(call.url).toBe(`${DEFAULT_BASE_URL}/models?limit=5`);
    expect(call.url).not.toContain(TOKEN);
    const headers = call.init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(headers["user-agent"]).toMatch(/^gridline-mcp\//);
  });

  test("passes the API's error fields through", async () => {
    const { fetch } = recorder(() =>
      Response.json(
        {
          error: {
            message: "No such file.",
            type: "invalid_request_error",
            param: "training_file",
            code: "file_not_found",
          },
        },
        { status: 404 },
      ),
    );
    const client = createClient({ token: TOKEN, baseUrl: DEFAULT_BASE_URL, fetch });
    const error = (await client
      .post("/fine_tuning/jobs", {})
      .catch((e: unknown) => e)) as GridlineApiError;
    expect(error).toBeInstanceOf(GridlineApiError);
    expect(error.toJSON()).toEqual({
      error: {
        message: "No such file.",
        status: 404,
        code: "file_not_found",
        param: "training_file",
        type: "invalid_request_error",
      },
    });
  });

  test("scrubs the key from error messages, API- and transport-made alike", async () => {
    const echo = recorder(() =>
      Response.json({ error: { message: `bad key ${TOKEN}` } }, { status: 401 }),
    );
    const a = (await createClient({ token: TOKEN, baseUrl: DEFAULT_BASE_URL, fetch: echo.fetch })
      .get("/models")
      .catch((e: unknown) => e)) as GridlineApiError;
    expect(a.message).toBe("bad key [redacted]");
    const broken: FetchLike = async () => {
      throw new Error(`socket closed for ${TOKEN}`);
    };
    const b = (await createClient({ token: TOKEN, baseUrl: DEFAULT_BASE_URL, fetch: broken })
      .get("/models")
      .catch((e: unknown) => e)) as GridlineApiError;
    expect(b.message).not.toContain(TOKEN);
    expect(b.status).toBe(0);
    const plain = recorder(() => new Response(`oops ${TOKEN}`, { status: 502 }));
    const c = (await createClient({ token: TOKEN, baseUrl: DEFAULT_BASE_URL, fetch: plain.fetch })
      .get("/models")
      .catch((e: unknown) => e)) as GridlineApiError;
    expect(c.message).toBe("HTTP 502: oops [redacted]");
    expect(scrub("abc", "ab")).toBe("abc");
  });

  test("encodes path segments so an id cannot change the route", () => {
    expect(seg("ftjob-1")).toBe("ftjob-1");
    expect(seg("../files")).toBe("..%2Ffiles");
    expect(seg("ft:qwen2.5:abc")).toBe("ft%3Aqwen2.5%3Aabc");
    for (const dots of [".", "..", "%2e", "%2E%2e", ".%2E"])
      expect(() => seg(dots)).toThrow(GridlineApiError);
    expect(seg("...")).toBe("...");
  });
});
