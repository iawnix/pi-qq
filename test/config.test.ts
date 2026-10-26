import test from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { accessWarnings, readConfig, readSecret } from "../src/config.js";
import { config } from "./helpers.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

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

test("CLI check accepts a host-following configuration without local Pi model setup", async () => {
  const cfg = config();
  const path = join(cfg.dataDir, "qqbot.json");
  await writeFile(path, JSON.stringify({ appId: "test", appSecret: "fake", agentDir: join(cfg.dataDir, "empty") }));
  const result = await promisify(execFile)(process.execPath, ["--import", "tsx", "src/cli.ts", "check", "--config", path]);
  assert.match(result.stdout, /Pi 扩展将跟随当前模型/);
  assert.match(result.stdout, /尚未验证模型/);
  assert.match(result.stderr, /没有允许的用户或群/);
});

test("sample OpenIDs are reported without printing configured credentials", () => {
  const cfg = config();
  assert.deepEqual(accessWarnings(cfg), []);
  cfg.allowUsers = ["YOUR_C2C_USER_OPENID"];
  cfg.groups = { YOUR_GROUP_OPENID: cfg.groups.g! };
  cfg.appSecret = "DO_NOT_PRINT_SECRET";
  const warnings = accessWarnings(cfg);
  assert.equal(warnings.length, 2);
  assert.match(warnings.join(" "), /\/qq ids/);
  assert.ok(!warnings.join(" ").includes(cfg.appSecret));
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
