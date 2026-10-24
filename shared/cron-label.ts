const WEEKDAY_LABELS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"] as const;

/**
 * 把 5 字段 cron（分 时 日 月 周）翻译成人话。
 * 认不出来的表达式原样返回，绝不猜——宁可显示 `0 18 * * 1,3` 也不编一个错的。
 */
export function describeCron(cron: string): string {
  const fields = String(cron ?? "").trim().split(/\s+/);
  if (fields.length !== 5) return String(cron ?? "");
  const [minute = "", hour = "", dayOfMonth = "", month = "", dayOfWeek = ""] = fields;
  if (!/^[\d*,/-]+$/.test(fields.join(""))) return cron;

  const step = minute.match(/^\*\/(\d+)$/);
  if (step && hour === "*" && dayOfMonth === "*" && month === "*" && dayOfWeek === "*") {
    return `每 ${step[1]} 分钟`;
  }
  if (minute === "*" && hour === "*" && dayOfMonth === "*" && month === "*" && dayOfWeek === "*") {
    return "每分钟";
  }
  if (!/^\d+$/.test(minute)) return cron;
  if (hour === "*" && dayOfMonth === "*" && month === "*" && dayOfWeek === "*") {
    return `每小时第 ${minute} 分`;
  }
  if (!/^\d+$/.test(hour)) return cron;

  const time = `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`;
  if (dayOfMonth === "*" && month === "*" && dayOfWeek === "*") return `每天 ${time}`;
  if (dayOfMonth === "*" && month === "*" && /^[0-6]$/.test(dayOfWeek)) {
    return `每${WEEKDAY_LABELS[Number(dayOfWeek)] ?? `周${dayOfWeek}`} ${time}`;
  }
  if (dayOfWeek === "*" && month === "*" && /^\d+$/.test(dayOfMonth)) {
    return `每月 ${dayOfMonth} 日 ${time}`;
  }
  return cron;
}
