const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const FORMATTERS = new Map();

function normalizeDeliveryControls(input = {}) {
  const raw = input.deliveryWindow && typeof input.deliveryWindow === "object" ? input.deliveryWindow : input;
  const timezone = validTimezone(raw.timezone) ? raw.timezone : "UTC";
  const weekdays = Array.isArray(raw.weekdays)
    ? Array.from(new Set(raw.weekdays.map(normalizeWeekday).filter((value) => value !== null)))
    : [];
  const startTime = validTime(raw.startTime) ? raw.startTime : null;
  const endTime = validTime(raw.endTime) ? raw.endTime : null;
  return {
    batchSize: Math.min(1000, Math.max(1, Number(input.batchSize) || 500)),
    batchIntervalMinutes: Math.min(1440, Math.max(0, Number(input.batchIntervalMinutes) || 0)),
    deliveryWindow: {
      enabled: raw.enabled === true || weekdays.length > 0 || Boolean(startTime && endTime),
      timezone,
      weekdays,
      startTime,
      endTime,
    },
  };
}

function isWithinDeliveryWindow(date, window = {}) {
  if (!window.enabled) return true;
  const parts = localParts(date, window.timezone || "UTC");
  if (window.weekdays?.length && !window.weekdays.includes(parts.weekday)) return false;
  if (!window.startTime || !window.endTime) return true;
  const minutes = parts.hour * 60 + parts.minute;
  const start = timeMinutes(window.startTime);
  const end = timeMinutes(window.endTime);
  return start <= end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}

function nextAllowedDeliveryAt(input, window = {}) {
  const start = new Date(input || Date.now());
  if (!window.enabled || isWithinDeliveryWindow(start, window)) return start;
  const cursor = new Date(Math.ceil(start.getTime() / 60000) * 60000);
  for (let minute = 0; minute <= 8 * 24 * 60; minute += 1) {
    if (isWithinDeliveryWindow(cursor, window)) return cursor;
    cursor.setTime(cursor.getTime() + 60000);
  }
  throw new Error("No valid delivery time exists in the next eight days. Check the allowed weekdays and hours.");
}

function nextBatchAt(now, controls) {
  const base = new Date(new Date(now || Date.now()).getTime() + Number(controls.batchIntervalMinutes || 0) * 60000);
  return nextAllowedDeliveryAt(base, controls.deliveryWindow || {});
}

function localParts(date, timezone) {
  let formatter = FORMATTERS.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    FORMATTERS.set(timezone, formatter);
  }
  const values = formatter.formatToParts(new Date(date)).reduce((result, part) => ({ ...result, [part.type]: part.value }), {});
  return {
    weekday: WEEKDAYS.indexOf(String(values.weekday || "").slice(0, 3).toLowerCase()),
    hour: Number(values.hour),
    minute: Number(values.minute),
  };
}

function normalizeWeekday(value) {
  if (Number.isInteger(Number(value)) && Number(value) >= 0 && Number(value) <= 6) return Number(value);
  const index = WEEKDAYS.indexOf(String(value || "").slice(0, 3).toLowerCase());
  return index >= 0 ? index : null;
}

function validTimezone(value) {
  if (!value) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date());
    return true;
  } catch (_error) {
    return false;
  }
}

function validTime(value) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value || ""));
}

function timeMinutes(value) {
  const [hour, minute] = String(value).split(":").map(Number);
  return hour * 60 + minute;
}

module.exports = {
  isWithinDeliveryWindow,
  nextAllowedDeliveryAt,
  nextBatchAt,
  normalizeDeliveryControls,
};
