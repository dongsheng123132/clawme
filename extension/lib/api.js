import { DEFAULT_BASE } from "./constants.js";

export async function getConfig() {
  const r = await chrome.storage.local.get({ baseUrl: DEFAULT_BASE, token: "" });
  return { baseUrl: r.baseUrl.replace(/\/$/, ""), token: r.token };
}

export async function fetchPending() {
  const { baseUrl, token } = await getConfig();
  if (!token) return { instructions: [] };
  const res = await fetch(`${baseUrl}/v1/instructions/pending?target=browser`, {
    headers: { "X-ClawMe-Token": token },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function reportResult(instructionId, status, result) {
  const { baseUrl, token } = await getConfig();
  await fetch(`${baseUrl}/v1/instructions/${instructionId}/result`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-ClawMe-Token": token },
    body: JSON.stringify({ instruction_id: instructionId, status, result }),
  });
}

export async function sendMessage(text, action) {
  const { baseUrl, token } = await getConfig();
  const res = await fetch(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-ClawMe-Token": token },
    body: JSON.stringify({ text, type: "quick_action", action }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
