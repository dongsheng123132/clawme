# ClawMe 浏览器插件

接收 ClawMe 后端的指令，在弹窗中展示，点击「执行」后在浏览器里替你完成（发推、写邮件、填表单、打开链接等），并上报结果。

支持的指令：**remind**（提醒）、**open_url**（打开链接）、**compose_tweet**（发推）、**compose_email**（写邮件）、**fill_form**（填表单）。

## 配置

在弹窗中填写 Backend URL（默认 `http://127.0.0.1:31871`）和 Token，点「保存」。

## 加载方式

1. 打开 Chrome `chrome://extensions`
2. 开启「开发者模式」
3. 「加载已解压的扩展程序」→ 选择本仓库的 `extension` 目录

## 协议

- 轮询：`GET /v1/instructions/pending?target=browser`，Header `X-ClawMe-Token`
- 上报：`POST /v1/instructions/:id/result`，Body `{ instruction_id, status, result? }`

详见仓库根目录 `docs/instruction-protocol.md`。
