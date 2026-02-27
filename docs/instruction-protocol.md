# ClawMe 指令协议

## 1. 身份与授权

- 每个「主人」在 ClawMe 侧有一个**账号**，并对应至少一个 **client_token**（可多设备多 token）。
- Agent（如 OpenClaw）向 ClawMe 后端发指令时，必须在请求中携带：
  - **Authorization**: `Bearer <client_token>`  
  或
  - **X-ClawMe-Token**: `<client_token>`
- 后端根据 token 解析出「主人」与可选「设备/端」，仅将指令下发给该主人已注册的客户端（浏览器/手机）。

## 2. 请求格式（Agent → ClawMe 后端）

- 方法：`POST`
- 路径：例如 `/v1/instructions` 或 `/api/instructions`
- Headers：`Content-Type: application/json`，以及上述 token。
- Body：JSON，结构建议如下。

```json
{
  "id": "uuid-optional",
  "target": "phone",
  "instruction": {
    "type": "remind",
    "payload": { ... }
  },
  "meta": {
    "from": "openclaw",
    "created_at": "2025-01-27T12:00:00Z"
  }
}
```

- **id**：可选，指令唯一标识，用于去重、结果回传与查询。
- **target**：`"phone"` | `"browser"` | `"any"`，指定下发到哪一类端；`any` 表示任一端均可执行。
- **instruction**：见下节。
- **meta**：可选，来源、时间等，便于排查与展示。

## 3. 指令类型与 payload

### 3.1 remind（仅提醒）

- **type**: `"remind"`
- **payload**:
  - `title`:  string，标题
  - `body`:   string，正文（支持简单 Markdown 或纯文本）
  - `action_label`: 可选，如「执行」「忽略」

```json
{
  "type": "remind",
  "payload": {
    "title": "给爱人发消息",
    "body": "内容：晚安，今天早点睡。",
    "action_label": "打开微信"
  }
}
```

### 3.2 open_url

- **type**: `"open_url"`
- **payload**:
  - `url`: string，必填
  - `in_new_tab`: 可选 boolean，默认 true

```json
{
  "type": "open_url",
  "payload": {
    "url": "https://example.com/form",
    "in_new_tab": true
  }
}
```

### 3.2.1 compose_tweet（浏览器端，发推快捷指令）

- **type**: `"compose_tweet"`
- **payload**:
  - `text`: string，推文内容（会打开 X/Twitter 发推 intent 页并预填，用户点发推即可）

```json
{
  "type": "compose_tweet",
  "payload": {
    "text": "今天天气不错 #ClawMe"
  }
}
```

### 3.2.2 compose_email（浏览器端，写邮件快捷指令）

- **type**: `"compose_email"`
- **payload**:
  - `to`: string，收件人邮箱
  - `subject`: string，主题
  - `body`: string，正文
  - `use_gmail`: 可选 boolean，默认 true；true 时打开 Gmail 撰写页，false 时用 mailto 链接

```json
{
  "type": "compose_email",
  "payload": {
    "to": "alice@example.com",
    "subject": "会议提醒",
    "body": "明天下午 3 点开会。",
    "use_gmail": true
  }
}
```

### 3.3 fill_form（浏览器端）

- **type**: `"fill_form"`
- **payload**:
  - `url`: 可选，要填写的页面 URL；缺省表示当前页
  - `fields`: 对象，键为选择器（CSS 或约定 name/id），值为要填写的字符串

```json
{
  "type": "fill_form",
  "payload": {
    "url": "https://example.com/apply",
    "fields": {
      "input[name=name]": "张三",
      "#email": "zhangsan@example.com"
    }
  }
}
```

### 3.4 click（浏览器端）

- **type**: `"click"`
- **payload**:
  - `selector`: string，CSS 选择器
  - `url`: 可选，先导航到该 URL 再点击；缺省表示当前页

```json
{
  "type": "click",
  "payload": {
    "selector": "button[type=submit]",
    "url": "https://example.com/form"
  }
}
```

### 3.5 extract（浏览器端）

- **type**: `"extract"`
- **payload**:
  - `selector`: string，要抓取的元素选择器
  - `attribute`: 可选，取属性值；缺省取 textContent
- 执行结果由客户端回传到后端，再可选转发给 Agent。

```json
{
  "type": "extract",
  "payload": {
    "selector": ".result-table",
    "attribute": null
  }
}
```

### 3.6 send_sms（手机端）

- **type**: `"send_sms"`
- **payload**:
  - `to`: string，号码（可带国家码）
  - `body`: string，短信内容

```json
{
  "type": "send_sms",
  "payload": {
    "to": "+8613800138000",
    "body": "晚安，今天早点睡。"
  }
}
```

### 3.7 run_shortcut（手机端，iOS）

- **type**: `"run_shortcut"`
- **payload**:
  - `name`: string，快捷方式名称
  - `input`: 可选，传入快捷方式的输入（若平台支持）

```json
{
  "type": "run_shortcut",
  "payload": {
    "name": "发微信给爱人",
    "input": "晚安"
  }
}
```

### 3.8 open_wechat（手机端，能力受限于 URL scheme）

- **type**: `"open_wechat"`
- **payload**:
  - `action`: 如 `"chat"`（打开到某聊天）
  - `identifier`: 可选，如用户 id 或备注（依赖微信 URL scheme 文档）

具体字段以微信实际支持的 scheme 为准；若无法预填内容，则仅打开微信，由用户手动发送，仍属「半自动」。

---

## 4. 客户端上报（执行结果，可选）

- 客户端执行后，可对后端上报：
  - `instruction_id`: 对应下发时的 `id`
  - `status`: `"ok"` | `"failed"` | `"cancelled"`
  - `result`: 可选，如 `extract` 抓到的文本、错误信息等
- 后端可再转给 Agent，便于 Agent 做下一步或记录。

---

## 5. 版本与扩展

- 协议版本建议放在 URL 或 header（如 `X-ClawMe-Protocol: 1`），便于后续不兼容时做分支。
- 新增指令类型时，在本文档补充 `type` 与 `payload` 约定，并标注支持的端（phone / browser）。
