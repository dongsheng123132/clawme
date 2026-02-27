import * as remind from "./instructions/remind.js";
import * as openUrl from "./instructions/open-url.js";
import * as composeTweet from "./instructions/compose-tweet.js";
import * as composeEmail from "./instructions/compose-email.js";
import * as fillForm from "./instructions/fill-form.js";
import * as click from "./instructions/click.js";
import * as extract from "./instructions/extract.js";
import { reportResult } from "./api.js";

const handlers = {
  remind,
  open_url: openUrl,
  compose_tweet: composeTweet,
  compose_email: composeEmail,
  fill_form: fillForm,
  click,
  extract,
};

export function renderPayload(type, payload) {
  const handler = handlers[type];
  if (handler?.renderPayload) return handler.renderPayload(payload);
  return JSON.stringify(payload);
}

/**
 * Execute an instruction and report result to backend.
 * Returns { status, result }.
 */
export async function executeInstruction(inst) {
  const { type, payload } = inst.instruction;
  const handler = handlers[type];

  let outcome;
  if (!handler) {
    outcome = { status: "failed", result: "不支持的指令类型: " + type };
  } else {
    try {
      outcome = await handler.execute(payload || {});
    } catch (e) {
      outcome = { status: "failed", result: String(e.message || e) };
    }
  }

  await reportResult(inst.id, outcome.status, outcome.result);
  return outcome;
}
