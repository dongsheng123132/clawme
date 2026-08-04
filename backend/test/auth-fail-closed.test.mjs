// relay 鉴权必须「配置缺失即拒绝」。
//
// 这组测试来自一次真实事故：线上 relay 没设 CLAWME_TOKENS，旧代码把「没配置」
// 当成「开发模式，全部放行」，而它前面挂着一条 Cloudflare 隧道 —— 于是从公网
// 随手编一个令牌就能拿到 HTTP 200。
//
// 「没配置」和「允许任何人」是两件完全不同的事，代码不能替运维做这个假设。

import assert from "node:assert/strict";
import test from "node:test";
import { getIdentityFromRequest, isTokenAllowed, isUnconfigured } from "../dist/auth.js";

const ENV_KEYS = ["CLAWME_TOKENS", "CLAWME_IDENTITIES", "CLAWME_ALLOW_ANY_TOKEN"];

function withEnv(values, body) {
  const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, values);
  try {
    body();
  } finally {
    for (const key of ENV_KEYS) delete process.env[key];
    for (const [key, value] of Object.entries(saved)) {
      if (value !== undefined) process.env[key] = value;
    }
  }
}

const request = (token) => ({ headers: { "x-clawme-token": token } });

test("没有任何凭据配置时，relay 谁都不放行", () => {
  withEnv({}, () => {
    assert.equal(isUnconfigured(), true);
    assert.equal(isTokenAllowed("test"), false);
    assert.equal(isTokenAllowed("随手编的令牌"), false);
    assert.equal(isTokenAllowed(""), false);
    assert.equal(isTokenAllowed(null), false);
    // 连身份解析也不能给出一个可用的 actor。
    assert.equal(getIdentityFromRequest(request("anything")), null);
  });
});

test("空白字符不算配置，仍然拒绝", () => {
  withEnv({ CLAWME_TOKENS: "   ,  , ", CLAWME_IDENTITIES: "   " }, () => {
    assert.equal(isUnconfigured(), true);
    assert.equal(isTokenAllowed("test"), false);
  });
});

test("放行任意令牌必须显式开口，而不是默认", () => {
  withEnv({ CLAWME_ALLOW_ANY_TOKEN: "1" }, () => {
    assert.equal(isTokenAllowed("任何令牌"), true);
    // 即便开了这个开关，空令牌依然不算通过。
    assert.equal(isTokenAllowed(null), false);
    assert.equal(isTokenAllowed(""), false);
  });
  // 只有字面量 "1" 才开；随便一个真值不算。
  withEnv({ CLAWME_ALLOW_ANY_TOKEN: "true" }, () => {
    assert.equal(isTokenAllowed("任何令牌"), false);
  });
});

test("配了令牌白名单就只认白名单", () => {
  withEnv({ CLAWME_TOKENS: "alpha, beta " }, () => {
    assert.equal(isUnconfigured(), false);
    assert.equal(isTokenAllowed("alpha"), true);
    assert.equal(isTokenAllowed("beta"), true);
    assert.equal(isTokenAllowed("gamma"), false);
    // 白名单存在时，开发用的放行开关不该还能撬开它。
  });
  withEnv({ CLAWME_TOKENS: "alpha", CLAWME_ALLOW_ANY_TOKEN: "1" }, () => {
    assert.equal(isTokenAllowed("gamma"), false);
  });
});

test("配了身份映射，未登记的令牌一律拒绝", () => {
  const identities = JSON.stringify({
    "phone-token": {
      actor_id: "phone-1",
      actor_kind: "device",
      surface: "android",
      role: "controller",
    },
  });
  withEnv({ CLAWME_IDENTITIES: identities }, () => {
    assert.equal(isUnconfigured(), false);
    assert.equal(isTokenAllowed("phone-token"), true);
    assert.equal(isTokenAllowed("别的令牌"), false);
    const identity = getIdentityFromRequest(request("phone-token"));
    assert.equal(identity.actorId, "phone-1");
    assert.equal(identity.role, "controller");
    assert.equal(identity.surface, "android");
  });
});

test("身份映射写坏了要整体失败，不能退回放行", () => {
  withEnv({ CLAWME_IDENTITIES: "{ 这不是 JSON" }, () => {
    // 配置写错时宁可全员拒绝，也不能因为解析失败就当没配过。
    assert.equal(isTokenAllowed("任何令牌"), false);
    assert.equal(getIdentityFromRequest(request("任何令牌")), null);
  });
});
