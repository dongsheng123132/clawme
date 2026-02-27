export const DEFAULT_BASE = "http://127.0.0.1:31871";
export const POLL_INTERVAL_SECONDS = 30;
export const POLL_ALARM_NAME = "clawme-poll";
export const LOG_MAX_ENTRIES = 100;

export const TYPE_LABELS = {
  remind: "提醒",
  open_url: "打开链接",
  compose_tweet: "发推",
  compose_email: "写邮件",
  fill_form: "填表单",
  click: "点击",
  extract: "抓取",
  add_calendar: "添加日历",
  upload_file: "上传文件",
};

export const STATUS_COLORS = {
  pending: "#f59e0b",
  running: "#3b82f6",
  ok: "#10b981",
  failed: "#ef4444",
  cancelled: "#6b7280",
};
