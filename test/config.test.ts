import test from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readConfig, readSecret } from "../src/config.js";
import { config } from "./helpers.js";

test("JSON AppSecret works without an environment variable; environment takes precedence", async t => {
  const cfg = config();
  cfg.secretEnv = "PI_QQ_CONFIG_TEST_SECRET";
  const previous = process.env[cfg.secretEnv];
  delete process.env[cfg.secretEnv];
  t.after(() => {
    if (previous === undefined) delete process.env[cfg.secretEnv];
    else process.env[cfg.secretEnv] = previous;
  });
  const path = join(cfg.dataDir, "qqbot.json");
  await writeFile(path, JSON.stringify({ ...cfg, appSecret: "  fake-file-secret  " }));
  const loaded = await readConfig(path);
  assert.equal(readSecret(loaded), "fake-file-secret");
  process.env[cfg.secretEnv] = "  fake-env-secret  ";
  assert.equal(readSecret(loaded), "fake-env-secret");
  assert.equal(readSecret(cfg), "fake-env-secret");
  process.env[cfg.secretEnv] = "  ";
  assert.equal(readSecret(loaded), "fake-file-secret");
  assert.throws(() => readSecret(cfg), /请填写 appSecret/);
  assert.throws(() => readSecret({ ...cfg, appSecret: "  " }), /请填写 appSecret/);
});

test("configuration errors do not expose inline secrets", async () => {
  const cfg = config();
  const path = join(cfg.dataDir, "qqbot.json");
  const secret = "FAKE_SECRET_MUST_NOT_APPEAR";
  for (const contents of [
    `{"appSecret": "${secret}" BROKEN}`,
    JSON.stringify({ ...cfg, appSecret: { value: secret } }),
  ]) {
    await writeFile(path, contents);
    await assert.rejects(readConfig(path), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /QQ 配置无效/);
      assert.ok(!error.message.includes(secret));
      return true;
    });
  }
});
