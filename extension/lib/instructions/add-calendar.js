/**
 * add_calendar — Generate an ICS file and trigger download.
 * macOS/iOS will open Apple Calendar; other systems use their default calendar app.
 *
 * payload:
 *   title:       string (required) — event title
 *   start:       string (required) — ISO 8601 datetime, e.g. "2026-03-01T14:00:00+08:00"
 *   end:         string (optional) — ISO 8601 datetime; defaults to start + 1 hour
 *   location:    string (optional) — event location
 *   description: string (optional) — event description/notes
 *   reminder:    number (optional) — minutes before event to remind (default 30)
 *   use_google:  boolean (optional) — if true, open Google Calendar URL instead of ICS
 */

function pad(n) {
  return String(n).padStart(2, "0");
}

function toICSDate(isoStr) {
  const d = new Date(isoStr);
  return (
    d.getUTCFullYear() +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) +
    "T" +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    pad(d.getUTCSeconds()) +
    "Z"
  );
}

function buildICS({ title, start, end, location, description, reminder = 30 }) {
  const dtStart = toICSDate(start);
  const dtEnd = end ? toICSDate(end) : toICSDate(new Date(new Date(start).getTime() + 3600000).toISOString());
  const uid = crypto.randomUUID() + "@clawme";
  const now = toICSDate(new Date().toISOString());

  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//ClawMe//Calendar//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${now}`,
    `DTSTART:${dtStart}`,
    `DTEND:${dtEnd}`,
    `SUMMARY:${(title || "").replace(/\n/g, "\\n")}`,
  ];

  if (location) lines.push(`LOCATION:${location.replace(/\n/g, "\\n")}`);
  if (description) lines.push(`DESCRIPTION:${description.replace(/\n/g, "\\n")}`);

  if (reminder >= 0) {
    lines.push(
      "BEGIN:VALARM",
      "TRIGGER:-PT" + reminder + "M",
      "ACTION:DISPLAY",
      `DESCRIPTION:${title || "Event reminder"}`,
      "END:VALARM"
    );
  }

  lines.push("END:VEVENT", "END:VCALENDAR");
  return lines.join("\r\n");
}

function buildGoogleCalendarUrl({ title, start, end, location, description }) {
  const fmt = (iso) => toICSDate(iso).replace("Z", "Z"); // already in correct format
  const dtStart = fmt(start);
  const dtEnd = end ? fmt(end) : fmt(new Date(new Date(start).getTime() + 3600000).toISOString());
  const params = new URLSearchParams();
  params.set("action", "TEMPLATE");
  params.set("text", title || "");
  params.set("dates", dtStart + "/" + dtEnd);
  if (location) params.set("location", location);
  if (description) params.set("details", description);
  return "https://calendar.google.com/calendar/render?" + params.toString();
}

export function renderPayload(payload) {
  const d = payload.start ? new Date(payload.start) : null;
  const dateStr = d ? `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}` : "?";
  return `📅 ${payload.title || "日程"} — ${dateStr}${payload.location ? " @ " + payload.location : ""}`;
}

export async function execute(payload) {
  const { title, start } = payload || {};
  if (!title) return { status: "failed", result: "缺少 title" };
  if (!start) return { status: "failed", result: "缺少 start（ISO 8601 日期时间）" };

  // Option: use Google Calendar URL
  if (payload.use_google) {
    const url = buildGoogleCalendarUrl(payload);
    chrome.tabs.create({ url });
    return { status: "ok", result: "已打开 Google Calendar 创建事件" };
  }

  // Default: generate ICS and trigger download via data URI
  const ics = buildICS(payload);
  const blob = new Blob([ics], { type: "text/calendar;charset=utf-8" });
  const dataUrl = await new Promise((resolve) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.readAsDataURL(blob);
  });

  // Create a tab with a page that auto-downloads the ICS
  const safeTitle = (title || "event").replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]/g, "_").slice(0, 50);
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>ClawMe Calendar</title></head><body>
<script>
  const a = document.createElement("a");
  a.href = ${JSON.stringify(dataUrl)};
  a.download = ${JSON.stringify(safeTitle + ".ics")};
  document.body.appendChild(a);
  a.click();
  setTimeout(() => window.close(), 2000);
</scr` + `ipt>
<p style="font-family:system-ui;text-align:center;margin-top:40px;color:#666">正在添加日历事件…</p>
</body></html>`;

  const tab = await chrome.tabs.create({
    url: "data:text/html;charset=utf-8," + encodeURIComponent(html),
  });

  return { status: "ok", result: `已生成日历事件「${title}」，正在下载 .ics 文件` };
}
