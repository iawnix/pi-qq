import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import { config } from "./helpers.js";

test("Friend launcher sets isolated agent/session paths and explicitly loads only QQ", async () => {
  const cfg = config();
  const root = cfg.dataDir;
  await mkdir(join(root, "bin"));
  const launcher = join(root, "start-friend.sh");
  await writeFile(launcher, await readFile(resolve("start-friend.sh")));
  await writeFile(join(root, "bin", "pi"), `#!${process.execPath}\nconsole.log(JSON.stringify({cwd:process.cwd(),agent:process.env.PI_CODING_AGENT_DIR,config:process.env.PI_QQ_CONFIG,args:process.argv.slice(2)}));\n`, { mode: 0o700 });
  const { stdout } = await promisify(execFile)("bash", [launcher, "--help"], { env: { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH}` } });
  const result = JSON.parse(stdout);
  assert.equal(result.cwd, root);
  assert.equal(result.agent, join(root, ".runtime/pi-agent"));
  assert.equal(result.config, join(root, "qqbot.json"));
  assert.deepEqual(result.args, ["--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "-e", join(root, "src/extension.ts"), "--session-dir", join(root, ".runtime/console-sessions"), "--help"]);
});

test("real Pi loader honors discovery opt-outs while loading the explicit QQ extension", async () => {
  const cfg = config();
  const agentDir = join(cfg.dataDir, ".runtime/pi-agent");
  for (const dir of [join(agentDir, "extensions"), join(agentDir, "skills/trap"), join(agentDir, "prompts"), join(cfg.dataDir, ".pi/extensions")]) await mkdir(dir, { recursive: true });
  await writeFile(join(agentDir, "extensions/trap.ts"), 'throw new Error("Global extension must not load");');
  await writeFile(join(cfg.dataDir, ".pi/extensions/trap.ts"), 'throw new Error("Project extension must not load");');
  await writeFile(join(agentDir, "skills/trap/SKILL.md"), "---\nname: trap\ndescription: must not load\n---\nPRIVATE_SKILL");
  await writeFile(join(agentDir, "prompts/trap.md"), "PRIVATE_PROMPT");
  const loader = new DefaultResourceLoader({ cwd: cfg.dataDir, agentDir, noExtensions: true, noSkills: true,
    noPromptTemplates: true, noThemes: true, additionalExtensionPaths: [resolve("src/extension.ts")] });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  assert.equal(loader.getExtensions().extensions.length, 1);
  assert.ok(loader.getExtensions().extensions[0]!.commands.has("qq"));
  assert.deepEqual(loader.getSkills().skills, []);
  assert.deepEqual(loader.getPrompts().prompts, []);
});
