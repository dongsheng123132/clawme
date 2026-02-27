export function renderPayload(payload) {
  return `${payload.title || "提醒"}: ${payload.body || ""}`;
}

export async function execute(payload) {
  return { status: "ok", result: "已查看提醒" };
}
