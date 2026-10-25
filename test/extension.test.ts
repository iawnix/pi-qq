import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";

test("Pi's actual extension loader loads source entry and registers command without starting gateway", async t => {
  const root = await mkdtemp(join(tmpdir(), "pi-qq-extension-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const loaded = await discoverAndLoadExtensions([resolve("src/extension.ts")], root, join(root, "agent"));
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1);
  assert.ok(loaded.extensions[0]!.commands.has("qq"));
  assert.ok(loaded.extensions[0]!.handlers.has("session_shutdown"));
});
