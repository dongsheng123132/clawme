# ClawMe — AI Assistant Integration Guide

You (the AI assistant) can send instructions to the user's Chrome browser via ClawMe.
The user has the ClawMe Chrome extension installed, which polls for instructions and executes them.

## API Endpoint

```
POST {CLAWME_URL}/v1/instructions
Headers: Content-Type: application/json, X-ClawMe-Token: {TOKEN}
```

Default: `http://127.0.0.1:31871` (local) or `https://api.clawme.net` (cloud)

## Send an Instruction

```bash
curl -X POST http://127.0.0.1:31871/v1/instructions \
  -H "Content-Type: application/json" \
  -H "X-ClawMe-Token: test" \
  -d '{"target":"browser","instruction":{"type":"TYPE","payload":{...}}}'
```

## Instruction Types

### fill_form — Fill a web form
```json
{"target":"browser","instruction":{"type":"fill_form","payload":{"url":"https://example.com/form","fields":{"#name":"John","input[name=email]":"john@example.com","select[name=country]":"US"}}}}
```
Use CSS selectors as keys. Supports inputs, textareas, selects, checkboxes, radio, contenteditable. Omit `url` to fill on the user's current page.

### compose_tweet — Draft a tweet
```json
{"target":"browser","instruction":{"type":"compose_tweet","payload":{"text":"Hello world!"}}}
```

### compose_email — Draft an email
```json
{"target":"browser","instruction":{"type":"compose_email","payload":{"to":"alice@example.com","subject":"Hi","body":"Email body","use_gmail":true}}}
```

### open_url — Open a URL
```json
{"target":"browser","instruction":{"type":"open_url","payload":{"url":"https://example.com","in_new_tab":true}}}
```

### click — Click an element
```json
{"target":"browser","instruction":{"type":"click","payload":{"selector":"button[type=submit]","url":"https://example.com/form"}}}
```

### extract — Extract content from page
```json
{"target":"browser","instruction":{"type":"extract","payload":{"selector":".results","url":"https://example.com"}}}
```
The extracted text is reported back via the result API.

### remind — Show notification
```json
{"target":"browser","instruction":{"type":"remind","payload":{"title":"Reminder","body":"Meeting in 5 min"}}}
```

## Multi-Step Workflow

Add `meta.workflow_id` and `meta.step` to chain instructions:
```json
{"target":"browser","instruction":{"type":"open_url","payload":{"url":"https://example.com/form"}},"meta":{"workflow_id":"signup","step":1}}
{"target":"browser","instruction":{"type":"fill_form","payload":{"fields":{"#name":"John"}}},"meta":{"workflow_id":"signup","step":2}}
{"target":"browser","instruction":{"type":"click","payload":{"selector":"button[type=submit]"}},"meta":{"workflow_id":"signup","step":3}}
```

## Check Result

```bash
curl http://127.0.0.1:31871/v1/instructions/pending?target=browser \
  -H "X-ClawMe-Token: test"
```

## How It Works

1. You send instruction → stored in backend
2. Chrome extension polls every 30s → shows in side panel
3. User clicks "Execute" → browser performs the action
4. Result reported back to backend

The user sees every instruction and confirms before execution. This is a "butler, not a boss" model.
