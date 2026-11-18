import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import requestCompat from "../../lib/grimoire/request-compat.cjs";

const { UnsupportedOption, ALLOWED_KEYS } = requestCompat as any;

interface MockResponseOptions {
  status?: number;
  text?: string;
  headers?: Record<string, string>;
}

function createMockResponse(options: MockResponseOptions = {}) {
  const status = options.status ?? 200;
  const bodyText = options.text ?? "";
  const headers = options.headers ?? {};

  return {
    status,
    headers: {
      get: (headerName: string) => headers[headerName.toLowerCase()] ?? null,
    },
    text: async () => bodyText,
  };
}

async function withInjectedFetch<T>(
  mockFetch: (url: string | URL | Request, init?: RequestInit) => Promise<any>,
  fn: () => Promise<T>
): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetch as any;
  try {
    return await fn();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function invokeRequestCompat(
  options: Record<string, unknown>
): Promise<{ err: any; res: any; body: any }> {
  return new Promise((resolve) => {
    requestCompat(options, (err: any, res: any, body: any) => {
      resolve({ err, res, body });
    });
  });
}

describe("request-compat: requestCompat", () => {
  describe("Callback execution exactly once", () => {
    it("invokes callback exactly once on successful response", async () => {
      let callCount = 0;
      await withInjectedFetch(
        async () => createMockResponse({ status: 200, text: "ok" }),
        async () => {
          await new Promise<void>((resolve, reject) => {
            requestCompat({ url: "/data" }, (err: any, res: any, body: any) => {
              callCount++;
              try {
                assert.equal(err, null);
                assert.equal(res.statusCode, 200);
                assert.equal(body, "ok");
              } catch (e) {
                reject(e);
                return;
              }
              setTimeout(() => {
                try {
                  assert.equal(callCount, 1);
                  resolve();
                } catch (e) {
                  reject(e);
                }
              }, 15);
            });
          });
        }
      );
    });

    it("invokes callback exactly once on network error", async () => {
      let callCount = 0;
      await withInjectedFetch(
        async () => {
          throw new Error("connection failure");
        },
        async () => {
          await new Promise<void>((resolve, reject) => {
            requestCompat({ url: "/data" }, (err: any, res: any, body: any) => {
              callCount++;
              try {
                assert(err instanceof Error);
                assert.equal(err.message, "connection failure");
                assert.equal(res, null);
                assert.equal(body, null);
              } catch (e) {
                reject(e);
                return;
              }
              setTimeout(() => {
                try {
                  assert.equal(callCount, 1);
                  resolve();
                } catch (e) {
                  reject(e);
                }
              }, 15);
            });
          });
        }
      );
    });
  });

  describe("HTTP 4xx and 5xx status codes (Requirement 7.11, 7.12)", () => {
    it("returns err = null with statusCode set on 400 Bad Request", async () => {
      await withInjectedFetch(
        async () => createMockResponse({ status: 400, text: "bad request body" }),
        async () => {
          const { err, res, body } = await invokeRequestCompat({ url: "/api" });
          assert.equal(err, null);
          assert.equal(res.statusCode, 400);
          assert.equal(res.status, 400);
          assert.equal(body, "bad request body");
        }
      );
    });

    it("returns err = null with statusCode set on 404 Not Found", async () => {
      await withInjectedFetch(
        async () => createMockResponse({ status: 404, text: "item not found" }),
        async () => {
          const { err, res, body } = await invokeRequestCompat({ url: "/missing" });
          assert.equal(err, null);
          assert.equal(res.statusCode, 404);
          assert.equal(res.status, 404);
          assert.equal(body, "item not found");
        }
      );
    });

    it("returns err = null with statusCode set on 500 Internal Server Error", async () => {
      await withInjectedFetch(
        async () => createMockResponse({ status: 500, text: "server exploded" }),
        async () => {
          const { err, res, body } = await invokeRequestCompat({ url: "/fault" });
          assert.equal(err, null);
          assert.equal(res.statusCode, 500);
          assert.equal(res.status, 500);
          assert.equal(body, "server exploded");
        }
      );
    });

    it("returns err = null with statusCode set on 502 Bad Gateway", async () => {
      await withInjectedFetch(
        async () => createMockResponse({ status: 502, text: "gateway error" }),
        async () => {
          const { err, res, body } = await invokeRequestCompat({ url: "/gateway" });
          assert.equal(err, null);
          assert.equal(res.statusCode, 502);
          assert.equal(res.status, 502);
          assert.equal(body, "gateway error");
        }
      );
    });
  });

  describe("JSON parsing (Requirement 7.14)", () => {
    it("parses valid JSON response body when json option is true", async () => {
      const payload = { success: true, count: 42, items: ["alpha", "beta"] };
      await withInjectedFetch(
        async () =>
          createMockResponse({
            status: 200,
            text: JSON.stringify(payload),
          }),
        async () => {
          const { err, res, body } = await invokeRequestCompat({
            url: "/json-endpoint",
            json: true,
          });
          assert.equal(err, null);
          assert.equal(res.statusCode, 200);
          assert.deepEqual(body, payload);
        }
      );
    });

    it("preserves raw text body when json is true but response is not valid JSON", async () => {
      const rawText = "<html><body>502 Bad Gateway</body></html>";
      await withInjectedFetch(
        async () => createMockResponse({ status: 502, text: rawText }),
        async () => {
          const { err, res, body } = await invokeRequestCompat({
            url: "/html-error",
            json: true,
          });
          assert.equal(err, null);
          assert.equal(res.statusCode, 502);
          assert.equal(body, rawText);
        }
      );
    });

    it("handles empty response text when json is true", async () => {
      await withInjectedFetch(
        async () => createMockResponse({ status: 204, text: "" }),
        async () => {
          const { err, res, body } = await invokeRequestCompat({
            url: "/empty",
            json: true,
          });
          assert.equal(err, null);
          assert.equal(res.statusCode, 204);
          assert.equal(body, "");
        }
      );
    });

    it("serializes json object option into request body and sets Content-Type", async () => {
      let capturedInit: RequestInit | undefined;
      const sendObject = { query: "search", limit: 10 };

      await withInjectedFetch(
        async (_url, init) => {
          capturedInit = init;
          return createMockResponse({ status: 201, text: "created" });
        },
        async () => {
          const { err } = await invokeRequestCompat({
            url: "/create",
            method: "POST",
            json: sendObject,
          });
          assert.equal(err, null);
          assert(capturedInit);
          assert.equal(capturedInit.body, JSON.stringify(sendObject));
          const headers = capturedInit.headers as Record<string, string>;
          assert.equal(headers["Content-Type"], "application/json");
        }
      );
    });
  });

  describe("Network error handling (Requirement 7.13)", () => {
    it("propagates network errors to callback and sets response/body to null", async () => {
      const networkFailure = new Error("DNS resolution failed");
      await withInjectedFetch(
        async () => {
          throw networkFailure;
        },
        async () => {
          const { err, res, body } = await invokeRequestCompat({
            url: "/unreachable",
          });
          assert.equal(err, networkFailure);
          assert.equal(res, null);
          assert.equal(body, null);
        }
      );
    });
  });

  describe("UnsupportedOption synchronous throwing (Requirement 7.1, 7.3)", () => {
    it("throws UnsupportedOption synchronously when disallowed option key is present", () => {
      const disallowedKeys = [
        "rejectUnauthorized",
        "proxy",
        "cert",
        "key",
        "ca",
        "encoding",
        "agent",
        "gzip",
        "forever",
        "jar",
      ];

      for (const disallowed of disallowedKeys) {
        assert.throws(
          () => {
            requestCompat({ url: "/test", [disallowed]: true }, () => {});
          },
          (err: any) => {
            assert(err instanceof UnsupportedOption);
            assert.equal(err.name, "UnsupportedOption");
            assert.equal(err.key, disallowed);
            assert(err.message.includes(disallowed));
            return true;
          }
        );
      }
    });

    it("accepts all keys declared in ALLOWED_KEYS", async () => {
      assert.deepEqual(ALLOWED_KEYS, [
        "url",
        "uri",
        "method",
        "headers",
        "body",
        "json",
        "qs",
        "timeout",
        "followRedirect",
      ]);

      await withInjectedFetch(
        async () => createMockResponse({ status: 200, text: "ok" }),
        async () => {
          const { err } = await invokeRequestCompat({
            url: "/test",
            method: "GET",
            headers: { "x-custom": "header" },
            qs: { page: 1 },
            timeout: 5000,
            followRedirect: false,
          });
          assert.equal(err, null);
        }
      );
    });
  });

  describe("URL building and query parameters", () => {
    it("uses uri option when url is not specified", async () => {
      let requestedUrl: string | undefined;
      await withInjectedFetch(
        async (url) => {
          requestedUrl = String(url);
          return createMockResponse({ status: 200, text: "ok" });
        },
        async () => {
          await invokeRequestCompat({ uri: "/via-uri" });
          assert.equal(requestedUrl, "/via-uri");
        }
      );
    });

    it("appends object query parameters with question mark", async () => {
      let requestedUrl: string | undefined;
      await withInjectedFetch(
        async (url) => {
          requestedUrl = String(url);
          return createMockResponse({ status: 200, text: "ok" });
        },
        async () => {
          await invokeRequestCompat({
            url: "/search",
            qs: { q: "term", limit: 5 },
          });
          assert.equal(requestedUrl, "/search?q=term&limit=5");
        }
      );
    });

    it("appends object query parameters with ampersand if url already has question mark", async () => {
      let requestedUrl: string | undefined;
      await withInjectedFetch(
        async (url) => {
          requestedUrl = String(url);
          return createMockResponse({ status: 200, text: "ok" });
        },
        async () => {
          await invokeRequestCompat({
            url: "/search?mode=fast",
            qs: { q: "term" },
          });
          assert.equal(requestedUrl, "/search?mode=fast&q=term");
        }
      );
    });

    it("appends string query parameters directly", async () => {
      let requestedUrl: string | undefined;
      await withInjectedFetch(
        async (url) => {
          requestedUrl = String(url);
          return createMockResponse({ status: 200, text: "ok" });
        },
        async () => {
          await invokeRequestCompat({
            url: "/query",
            qs: "raw=true&order=asc",
          });
          assert.equal(requestedUrl, "/query?raw=true&order=asc");
        }
      );
    });
  });

  describe("Redirect configuration", () => {
    it("sets redirect to manual when followRedirect is false", async () => {
      let capturedInit: RequestInit | undefined;
      await withInjectedFetch(
        async (_url, init) => {
          capturedInit = init;
          return createMockResponse({ status: 302, text: "redirecting" });
        },
        async () => {
          await invokeRequestCompat({
            url: "/redirect-me",
            followRedirect: false,
          });
          assert.equal(capturedInit?.redirect, "manual");
        }
      );
    });

    it("sets redirect to follow when followRedirect is true", async () => {
      let capturedInit: RequestInit | undefined;
      await withInjectedFetch(
        async (_url, init) => {
          capturedInit = init;
          return createMockResponse({ status: 200, text: "done" });
        },
        async () => {
          await invokeRequestCompat({
            url: "/redirect-me",
            followRedirect: true,
          });
          assert.equal(capturedInit?.redirect, "follow");
        }
      );
    });
  });
});
