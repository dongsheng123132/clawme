#!/usr/bin/env node
// ClawMe 设备配对 CLI。
//
// 签发一个短期、一次性的配对码，手机输进去换取只属于它自己的令牌。丢了手机就
// 吊销那一台，不用换掉所有端的凭据，也不用重启 relay。
//
//   node scripts/pair.mjs new --name "我的手机"
//   node scripts/pair.mjs new --name "工作机" --role owner --machine pc-1
//   node scripts/pair.mjs list
//   node scripts/pair.mjs revoke dev-1a2b3c4d
//
// 按 CLI-as-API 的规矩来：结果走 stdout，日志和提示走 stderr，--json 输出带稳定
// 的 ok 位，退出码简单。根令牌只从环境变量读，不接受命令行参数 —— 命令行会进
// shell 历史，也会出现在别人的 ps 输出里。
//
//   CLAWME_RELAY=https://api.clawme.net   relay 地址（默认 http://127.0.0.1:31871）
//   CLAWME_ROOT_TOKEN=<token>             relay 上配置的根令牌

const args = process.argv.slice(2);
const command = args[0];
const json = args.includes("--json");

function flag(name, fallback) {
  const index = args.indexOf(`--${name}`);
  return index === -1 || index + 1 >= args.length ? fallback : args[index + 1];
}

function flagAll(name) {
  const values = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === `--${name}` && args[i + 1]) values.push(args[i + 1]);
  }
  return values;
}

const relay = (process.env.CLAWME_RELAY ?? "http://127.0.0.1:31871").replace(/\/+$/, "");
const token = process.env.CLAWME_ROOT_TOKEN;

/** 结果去 stdout，其余一律 stderr —— 让这个命令能被管道和 AI 直接消费。 */
function out(value) {
  process.stdout.write(`${value}\n`);
}
function note(value) {
  process.stderr.write(`${value}\n`);
}

function fail(code, message, exitCode = 1) {
  if (json) out(JSON.stringify({ ok: false, error: code, message }));
  else note(`错误：${message}`);
  process.exit(exitCode);
}

if (!command || command === "--help" || command === "-h") {
  note(`用法：
  pair.mjs new --name <设备名> [--role controller|owner] [--surface android]
                [--machine <id>]... [--ttl <秒>] [--json]
  pair.mjs list [--json]
  pair.mjs revoke <device-id> [--json]

环境变量：
  CLAWME_RELAY       relay 地址（默认 http://127.0.0.1:31871）
  CLAWME_ROOT_TOKEN  relay 上配置的根令牌（必填）`);
  process.exit(command ? 0 : 64); // EX_USAGE
}

if (!token) {
  fail(
    "missing_root_token",
    "请设置 CLAWME_ROOT_TOKEN（relay 的 CLAWME_TOKENS 之一）。不要用命令行传令牌。",
    78, // EX_CONFIG
  );
}

async function call(path, init = {}) {
  let response;
  try {
    response = await fetch(`${relay}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        "X-ClawMe-Token": token,
        ...(init.headers ?? {}),
      },
    });
  } catch (error) {
    fail("relay_unreachable", `连不上 relay ${relay}：${error.message}`, 69); // EX_UNAVAILABLE
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    fail(
      body.error ?? `http_${response.status}`,
      body.message ?? `relay 返回 HTTP ${response.status}`,
      response.status === 401 || response.status === 403 ? 77 : 1, // EX_NOPERM
    );
  }
  return body;
}

if (command === "new") {
  const name = flag("name");
  if (!name) fail("missing_name", "请用 --name 给这台设备起个名字，方便以后认出来吊销哪一台", 64);

  const ttl = Number(flag("ttl", "300"));
  const body = await call("/v3/pairing/codes", {
    method: "POST",
    body: JSON.stringify({
      name,
      role: flag("role", "controller"),
      surface: flag("surface", "android"),
      machine_ids: flagAll("machine"),
      ttl_seconds: ttl,
    }),
  });

  if (json) {
    out(JSON.stringify({ ok: true, code: body.code, expires_at: body.expiresAt }));
  } else {
    note(`设备名：${name}`);
    note(`有效期至：${body.expiresAt}（约 ${Math.round(ttl / 60)} 分钟），只能用一次`);
    note("在手机的 ClawMe 里输入这个码：");
    out(body.code);
  }
} else if (command === "list") {
  const body = await call("/v3/devices");
  if (json) {
    out(JSON.stringify({ ok: true, devices: body.devices }));
  } else if (!body.devices.length) {
    note("还没有配对过任何设备。");
  } else {
    for (const device of body.devices) {
      const state = device.revokedAt ? `已吊销 ${device.revokedAt}` : "可用";
      const seen = device.lastSeenAt ? `最后活跃 ${device.lastSeenAt}` : "从未连接";
      out(`${device.id}  ${device.name}  ${device.role}/${device.surface ?? "-"}  ${state}  ${seen}`);
    }
  }
} else if (command === "revoke") {
  const deviceId = args[1];
  if (!deviceId || deviceId.startsWith("--")) {
    fail("missing_device_id", "请给出要吊销的设备 ID（用 pair.mjs list 查看）", 64);
  }
  const body = await call(`/v3/devices/${encodeURIComponent(deviceId)}/revoke`, { method: "POST" });
  if (json) out(JSON.stringify({ ok: true, device: body.device }));
  else {
    note(`已吊销 ${body.device.name}（${body.device.id}），立即生效，无需重启 relay。`);
    out(body.device.id);
  }
} else {
  fail("unknown_command", `未知子命令：${command}`, 64);
}
