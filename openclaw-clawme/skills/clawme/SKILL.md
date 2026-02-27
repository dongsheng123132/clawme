---
name: clawme
description: Execute actions in user's browser via ClawMe extension — tweet, email, fill forms, click elements, extract content. 7 instruction types. User confirms in side panel.
---

# ClawMe — Execute Actions in User's Browser

When the user wants to **do things in the browser**, use **clawme_send** to send instructions (set target to `browser`). The user sees instructions in the ClawMe browser extension side panel and clicks "Execute" to carry them out.

## Compose Tweet (X/Twitter)

When user says "tweet about...", "post on X...", "send a tweet saying...":

- **type**: `compose_tweet`
- **payload**: `{ "text": "tweet content" }`

Example: `clawme_send(target="browser", type="compose_tweet", payload={"text": "Just launched my new project! #BuildInPublic"})`
Opens Twitter/X compose page with pre-filled text. User clicks Post.

## Compose Email

When user says "write an email to...", "send email to...":

- **type**: `compose_email`
- **payload**: `{ "to": "email@example.com", "subject": "Subject", "body": "Email body", "use_gmail": true }`
  `use_gmail` defaults to true (opens Gmail compose). Set false for mailto link.

Example: `clawme_send(target="browser", type="compose_email", payload={"to":"alice@example.com","subject":"Meeting Reminder","body":"Meeting at 3pm tomorrow."})`

## Fill Form

When user says "fill the form on...", "enter my info on this page...":

- **type**: `fill_form`
- **payload**: `{ "url": "optional page URL; omit for current page", "fields": { "CSS_selector": "value", ... } }`

Example: `clawme_send(target="browser", type="fill_form", payload={"url":"https://example.com/contact","fields":{"#name":"John Doe","input[name=email]":"john@example.com"}})`

Supports: standard inputs, textareas, selects, checkboxes, radio buttons, and contenteditable rich text editors (like Xiaohongshu, Medium). Selectors must match the target page (e.g. `#id`, `input[name=xxx]`, `.class`).

## Click Element

When user says "click the submit button on...", "press the login button...":

- **type**: `click`
- **payload**: `{ "selector": "CSS selector", "url": "optional, navigate first" }`

Example: `clawme_send(target="browser", type="click", payload={"selector":"button[type=submit]","url":"https://example.com/form"})`

## Extract Content

When user says "get the text from...", "scrape the results...", "what does this page say...":

- **type**: `extract`
- **payload**: `{ "selector": "CSS selector", "attribute": "optional attr name", "url": "optional, navigate first" }`

Example: `clawme_send(target="browser", type="extract", payload={"selector":".search-results","url":"https://example.com/search?q=test"})`
Returns the textContent (or specified attribute) of the matched element. Result is sent back to the agent.

## Open URL

- **type**: `open_url`
- **payload**: `{ "url": "https://...", "in_new_tab": true }`

## Remind / Notify

- **type**: `remind`
- **payload**: `{ "title": "Title", "body": "Message body" }`

Shows a desktop notification. User sees it in the side panel.

## Multi-Step Workflows

Chain multiple instructions by adding `meta.workflow_id` and `meta.step`:

```
clawme_send(target="browser", type="open_url", payload={"url":"https://example.com/form"}, meta={"workflow_id":"apply-job","step":1})
clawme_send(target="browser", type="fill_form", payload={"fields":{"#name":"John"}}, meta={"workflow_id":"apply-job","step":2})
clawme_send(target="browser", type="click", payload={"selector":"button[type=submit]"}, meta={"workflow_id":"apply-job","step":3})
```

User sees a workflow progress bar and can execute all steps sequentially.
