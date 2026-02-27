---
name: clawme
description: Use clawme_send to run actions in the user's browser (tweet, email, fill form). User sees instructions in ClawMe extension and clicks Execute.
---

# ClawMe — 在用户浏览器里执行

当用户希望**在浏览器里**完成这些事时，使用 **clawme_send** 下发指令（target 填 `browser`），用户会在 ClawMe 浏览器插件里看到并点「执行」完成。

## 发推（X/Twitter）

用户说「帮我在推特发一条」「发个推说 xxx」时：

- **type**: `compose_tweet`
- **payload**: `{ "text": "推文内容" }`

示例：`clawme_send(target="browser", type="compose_tweet", payload={"text": "今天天气不错"})`  
插件会打开发推页并预填内容，用户点发推即可。

## 写邮件

用户说「写一封邮件给 xxx」「发邮件给 xx 主题 xx 正文 xx」时：

- **type**: `compose_email`
- **payload**: `{ "to": "邮箱", "subject": "主题", "body": "正文", "use_gmail": true }`  
  `use_gmail` 默认 true（打开 Gmail 撰写页）；false 则用 mailto 链接。

示例：`clawme_send(target="browser", type="compose_email", payload={"to":"alice@example.com","subject":"会议提醒","body":"明天下午 3 点开会。"})`

## 填表单

用户说「在 xx 网站填一下表单」「帮我在这个页面填姓名、邮箱」时：

- **type**: `fill_form`
- **payload**: `{ "url": "可选，要填写的页面 URL；不填则用当前页", "fields": { "CSS选择器": "要填的值", ... } }`

示例：`clawme_send(target="browser", type="fill_form", payload={"url":"https://example.com/contact","fields":{"#name":"张三","input[name=email]":"zs@example.com"}})`

选择器需与目标页面结构匹配（如 `#id`、`input[name=xxx]`、`.class`）。

## 仅打开链接

- **type**: `open_url`
- **payload**: `{ "url": "https://...", "in_new_tab": true }`

## 仅提醒

- **type**: `remind`
- **payload**: `{ "title": "标题", "body": "正文" }`

用户会在插件里看到提醒，点「执行」仅表示已读。
