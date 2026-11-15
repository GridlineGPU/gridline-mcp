/**
 * A small HTTP client for Gridline's OpenAI-compatible API (https://api.gridlinegpu.com/openai/v1),
 * used by the MCP server's tools. The API key comes from GRIDLINE_TOKEN (the name the docs and the
 * Python SDK use). It is sent only in the Authorization header of requests to the configured base URL
 * and never appears in a result, an error message or a log line: every message that leaves this file
 * is scrubbed of the key first.
 */

import { MCP_VERSION } from "./version.ts";

export const DEFAULT_BASE_URL = "https://api.gridlinegpu.com/openai/v1";
export const TOKEN_ENV = "GRIDLINE_TOKEN";
export const BASE_URL_ENV = "GRIDLINE_BASE_URL";
const USER_AGENT = `gridline-mcp/${MCP_VERSION}`;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type GridlineConfig = Readonly<{
  token: string;
  baseUrl: string;
  fetch: FetchLike;
}>;

type Env = Readonly<Record<string, string | undefined>>;

/**
 * The client configuration from the environment, or a refusal word. The base URL must be https
 * (http only for localhost, for tests and local development), so the key is never sent in clear text.
 */
export function configFromEnv(
  env: Env,
  fetchImpl: FetchLike = fetch,
): GridlineConfig | { error: string } {
  const token = env[TOKEN_ENV]?.trim() ?? "";
  if (token === "")
    return { error: `Set ${TOKEN_ENV} to a Gridline API key (create one in the dashboard).` };
  const raw = (env[BASE_URL_ENV]?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { error: `${BASE_URL_ENV} is not a URL.` };
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local))
    return { error: `${BASE_URL_ENV} must be an https URL.` };
  return Object.freeze({ token, baseUrl: raw, fetch: fetchImpl });
}

/** An API refusal or a transport failure, with the API's own error fields when it sent them. */
export class GridlineApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly param: string | null;
  readonly type: string | null;
  constructor(
    message: string,
    status: number,
    fields: { code?: string | null; param?: string | null; type?: string | null } = {},
  ) {
    super(message);
    this.name = "GridlineApiError";
    this.status = status;
    this.code = fields.code ?? null;
    this.param = fields.param ?? null;
    this.type = fields.type ?? null;
  }

  /** The error as a plain object for a tool result. */
  toJSON(): Record<string, unknown> {
    return {
      error: {
        message: this.message,
        status: this.status,
        code: this.code,
        param: this.param,
        type: this.type,
      },
    };
  }
}

/** Replace every occurrence of the key in a text (defence in depth: the API never echoes it). */
export function scrub(text: string, token: string): string {
  return token.length >= 4 ? text.split(token).join("[redacted]") : text;
}

export type GridlineClient = Readonly<{
  get(path: string, query?: Record<string, string | number | undefined>): Promise<unknown>;
  post(path: string, body?: unknown): Promise<unknown>;
  postForm(path: string, form: FormData): Promise<unknown>;
  delete(path: string): Promise<unknown>;
  /** A raw response body (file content). */
  getBytes(path: string): Promise<Uint8Array>;
}>;

/** Path segments are ids chosen by the API or the user: encode them so none can change the route. */
export function seg(value: string): string {
  // URL normalisation resolves "." and ".." (and their %2e spellings) away, so refuse them.
  if (/^(?:\.|%2e){1,2}$/i.test(value))
    throw new GridlineApiError(`Not a valid id: ${JSON.stringify(value)}.`, 400);
  return encodeURIComponent(value);
}

export function createClient(config: GridlineConfig): GridlineClient {
  const headers = (extra: Record<string, string> = {}) => ({
    authorization: `Bearer ${config.token}`,
    "user-agent": USER_AGENT,
    ...extra,
  });

  async function send(path: string, init: RequestInit): Promise<Response> {
    let response: Response;
    try {
      response = await config.fetch(`${config.baseUrl}${path}`, init);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new GridlineApiError(scrub(`Request failed: ${message}`, config.token), 0);
    }
    if (response.ok) return response;
    const text = await response.text().catch(() => "");
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    const error =
      parsed !== null && typeof parsed === "object" && "error" in parsed
        ? (parsed as { error?: Record<string, unknown> }).error
        : undefined;
    const message =
      typeof error?.message === "string" && error.message !== ""
        ? error.message
        : `HTTP ${response.status}${text === "" ? "" : `: ${text.slice(0, 300)}`}`;
    throw new GridlineApiError(scrub(message, config.token), response.status, {
      code: typeof error?.code === "string" ? error.code : null,
      param: typeof error?.param === "string" ? error.param : null,
      type: typeof error?.type === "string" ? error.type : null,
    });
  }

  async function json(response: Response): Promise<unknown> {
    const text = await response.text();
    if (text === "") return {};
    try {
      return JSON.parse(text);
    } catch {
      throw new GridlineApiError("The API answered with a body that is not JSON.", response.status);
    }
  }

  return Object.freeze({
    async get(path, query) {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(query ?? {}))
        if (value !== undefined) params.set(key, String(value));
      const suffix = params.size === 0 ? "" : `?${params.toString()}`;
      return json(await send(`${path}${suffix}`, { method: "GET", headers: headers() }));
    },
    async post(path, body) {
      return json(
        await send(path, {
          method: "POST",
          headers: headers({ "content-type": "application/json" }),
          body: JSON.stringify(body ?? {}),
        }),
      );
    },
    async postForm(path, form) {
      return json(await send(path, { method: "POST", headers: headers(), body: form }));
    },
    async delete(path) {
      return json(await send(path, { method: "DELETE", headers: headers() }));
    },
    async getBytes(path) {
      const response = await send(path, { method: "GET", headers: headers() });
      return new Uint8Array(await response.arrayBuffer());
    },
  });
}
