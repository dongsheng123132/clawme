// ActionParity / 影核协议一致性测试。
//
// 目的：不用手机、不用模拟器、不用截图，就能证明清单里声称的每条绑定都真实存在，
// 而且 iOS、relay 和 owner agent 指向的是同一个 Action ID。
// 这是"AI 能自己测试"的那一层——真机 UI 测试只负责人能不能看到、点得到。

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { SHADOW_ACTION, SHADOW_PROTOCOL } from "../dist/shadow.js";
import { SYNC_PROTOCOL } from "../dist/sync.js";

const backendRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repoRoot = path.dirname(backendRoot);

const read = (relative) => readFileSync(path.join(repoRoot, relative), "utf8");
const manifest = JSON.parse(read("action-parity.json"));

const sources = {
  routes: read("backend/src/v3-routes.ts"),
  ios: [
    read("ios/ClawMe/Views/ShadowCoreView.swift"),
    read("ios/ClawMe/Services/ConnectionManager.swift"),
  ].join("\n"),
  agent: [
    read("agent/src/shadow-worker.mjs"),
    read("agent/src/action-cli-bridge.mjs"),
  ].join("\n"),
};

function routeExists(method, template) {
  // app.get("/v3/sync/tasks/:id", ...) —— 路径必须逐字出现，写错一个段就会被抓到
  return sources.routes.includes(`app.${method.toLowerCase()}("${template}"`);
}

test("清单本身结构完整，且每个动作都可无界面执行", () => {
  assert.equal(manifest.spec_version, "0.1.0");
  assert.equal(manifest.application.id, "org.clawme.dutydesk");
  assert.ok(manifest.actions.length >= 4);
  for (const action of manifest.actions) {
    assert.equal(action.execution.headless, true, `${action.id} 必须可无界面执行`);
    assert.ok(action.bindings.length >= 2, `${action.id} 至少要有两个界面绑定`);
    assert.ok(action.input_schema && action.output_schema, `${action.id} 缺少契约`);
  }
});

test("线上协议标识与清单一致，改一处必须两处一起改", () => {
  assert.equal(SYNC_PROTOCOL, "action-parity/sync@0.1");
  assert.equal(SHADOW_PROTOCOL, SYNC_PROTOCOL);
  const snapshot = manifest.actions.find((action) => action.id === "task.status");
  const delta = manifest.actions.find((action) => action.id === "task.events");
  assert.equal(snapshot.output_schema.properties.protocol.const, SYNC_PROTOCOL);
  assert.equal(delta.output_schema.properties.protocol.const, SYNC_PROTOCOL);
});

test("owner 端写动作的 Action ID 与清单一致", () => {
  assert.equal(SHADOW_ACTION, "checkpoint.create");
  const write = manifest.actions.find((action) => action.id === SHADOW_ACTION);
  assert.ok(write, "清单里必须有 owner 执行的写动作");
  assert.equal(write.effects.class, "write");
  assert.equal(write.effects.confirmation, "always");
  assert.equal(write.effects.audit_required, true);
  assert.equal(write.execution.idempotent, true);
});

test("relay 绑定声明的每条路由都真实存在", () => {
  const checked = [];
  for (const action of manifest.actions) {
    for (const binding of action.bindings) {
      if (binding.surface !== "relay-api") continue;
      const match = /^api:(GET|POST|PUT|DELETE) ([^\s?]+)/.exec(binding.target);
      assert.ok(match, `无法解析 relay 绑定：${binding.target}`);
      const [, method, template] = match;
      assert.ok(
        routeExists(method, template),
        `${action.id}: v3-routes.ts 里找不到 ${method} ${template}`,
      );
      checked.push(`${method} ${template}`);
    }
  }
  assert.ok(checked.length >= 4, "每个动作都应该有 relay 绑定");
});

test("ios bindings exist —— 原生影子的绑定标识真实存在", () => {
  for (const action of manifest.actions) {
    const binding = action.bindings.find((item) => item.surface === "ios");
    assert.ok(binding, `${action.id} 缺少 iOS 绑定`);
    const identifier = /^ios:accessibilityIdentifier=(\S+)$/.exec(binding.target);
    if (identifier) {
      assert.ok(
        sources.ios.includes(`.accessibilityIdentifier("${identifier[1]}")`),
        `${action.id}: Swift 源码里找不到自动化标识 ${identifier[1]}`,
      );
      continue;
    }
    // 投影类绑定（没有按钮，是代码里的同步入口）只需符号存在
    const symbol = /^ios:([A-Za-z]+\.[A-Za-z]+)/.exec(binding.target);
    assert.ok(symbol, `无法解析 iOS 绑定：${binding.target}`);
    const [type, member] = symbol[1].split(".");
    assert.ok(
      sources.ios.includes(`func ${member}`) || sources.ios.includes(`${type}.${member}`),
      `${action.id}: Swift 源码里找不到投影入口 ${symbol[1]}`,
    );
  }
});

test("owner agent 绑定指向真实的命令类型", () => {
  for (const action of manifest.actions) {
    const binding = action.bindings.find((item) => item.surface === "owner-agent");
    if (!binding) continue;
    const command = /^agent:command (\S+)/.exec(binding.target);
    if (command) {
      assert.ok(
        sources.agent.includes(`"${command[1]}"`),
        `${action.id}: agent 源码里找不到命令类型 ${command[1]}`,
      );
      continue;
    }
    const bridge = /^agent:ActionCliBridge\.(\w+)/.exec(binding.target);
    assert.ok(bridge, `无法解析 agent 绑定：${binding.target}`);
    assert.ok(
      sources.agent.includes(`${bridge[1]}(`),
      `${action.id}: agent 源码里找不到 ActionCliBridge.${bridge[1]}`,
    );
  }
});

test("iOS 确认界面显示动作、状态版本和有效期后才提交", () => {
  // 影核协议要求确认绑定到具体动作，而不是一句"确定吗？"
  assert.ok(sources.ios.includes("challenge.actionId"));
  assert.ok(sources.ios.includes("expectedStateVersion"));
  assert.ok(sources.ios.includes("challenge.expiresAt"));
});
