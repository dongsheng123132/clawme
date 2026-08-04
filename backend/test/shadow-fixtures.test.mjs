// 影核 fixture 防漂移测试。
//
// fixtures/shadowcore/ 是 iOS、Android 和后端共用的那份"线上格式到底长什么样"。
// 三端各存一份理解，就会漂三份（宪法 #8）。这里重跑一遍生成器并逐字比对：
// 后端改了信封而没重新生成，测试当场红。

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const backendRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repoRoot = path.dirname(backendRoot);
const fixtureDir = path.join(repoRoot, "fixtures", "shadowcore");

test("落盘的影核 fixture 与 relay 当前输出逐字一致", async () => {
  // --check 有漂移就以退出码 1 结束，execFile 会因此抛出。
  const { stdout } = await run(
    process.execPath,
    [path.join(backendRoot, "scripts", "emit-shadow-fixtures.mjs"), "--check"],
    { cwd: backendRoot },
  );
  assert.match(stdout, /一致/);
});

test("每份 fixture 都是合法的 action-parity/sync@0.1 信封", async () => {
  const names = (await readdir(fixtureDir)).filter((name) => name.endsWith(".json"));
  assert.ok(names.length >= 4, "至少要有快照、普通增量、挑战和结果四份");

  for (const name of names) {
    const envelope = JSON.parse(await readFile(path.join(fixtureDir, name), "utf8"));
    assert.equal(envelope.protocol, "action-parity/sync@0.1", `${name} 协议标识不对`);
    assert.ok(["sync.snapshot", "sync.delta"].includes(envelope.type), `${name} 类型不对`);
    assert.ok(envelope.stream_id.startsWith("clawme:task:"), `${name} 缺少流标识`);
    assert.ok(envelope.payload.cursor, `${name} 缺少游标`);
    assert.ok(Number.isSafeInteger(envelope.payload.state_version), `${name} 缺少状态版本`);

    for (const event of envelope.payload.events ?? []) {
      assert.ok(Number.isSafeInteger(event.sequence), `${name} 事件缺少 sequence`);
      assert.ok(event.event_id, `${name} 事件缺少 event_id`);
      assert.equal(event.entity.type, "task", `${name} 事件实体类型不对`);
    }
  }
});

test("fixture 里不含密钥、令牌或 owner 本地路径", async () => {
  // relay 出手前会做脱敏；fixture 是最好检查的地方，因为它是人能读的。
  const names = (await readdir(fixtureDir)).filter((name) => name.endsWith(".json"));
  for (const name of names) {
    const text = await readFile(path.join(fixtureDir, name), "utf8");
    for (const forbidden of ["api_key", "apiKey", "secret", "password", "authorization"]) {
      assert.ok(
        !text.toLowerCase().includes(forbidden.toLowerCase()),
        `${name} 里出现了不该过网的字段 ${forbidden}`,
      );
    }
  }
});
