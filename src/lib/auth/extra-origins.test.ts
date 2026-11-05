import test from "node:test";
import assert from "node:assert/strict";
import { parseExtraOrigins } from "./extra-origins.ts";
test("parseExtraOrigins keeps exact https origins only", () => {
  assert.deepEqual(parseExtraOrigins(" https://a.ngrok-free.dev , https://a.ngrok-free.dev/,http://x.dev,https://*.evil.com,https://u:p@h.dev,https://h.dev/path,junk,"), ["https://a.ngrok-free.dev"]);
  assert.deepEqual(parseExtraOrigins(undefined), []);
});
