import type { Settings } from "./settings.ts";

type Hours = Settings["hours"];
const DAY = 24 * 60 * 60 * 1000;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

interface ZonedParts {
  ymd: string; // YYYY-MM-DD in the shop's timezone
  weekday: number; // 0 = Sunday
  minutes: number; // minutes since local midnight
}

export function zonedParts(d: Date, tz: string): ZonedParts {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
      hourCycle: "h23",
    })
      .formatToParts(d)
      .map((p) => [p.type, p.value]),
  );
  return {
    ymd: `${parts.year}-${parts.month}-${parts.day}`,
    weekday: WEEKDAYS.indexOf(parts.weekday!),
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

function offsetMinutes(d: Date, tz: string): number {
  const p = zonedParts(d, tz);
  const [y, m, day] = p.ymd.split("-").map(Number) as [number, number, number];
  const asUtc = Date.UTC(y, m - 1, day, Math.floor(p.minutes / 60), p.minutes % 60);
  return Math.round((asUtc - Math.floor(d.getTime() / 60_000) * 60_000) / 60_000);
}

/** The instant when the clock in `tz` shows `ymd hh:mm`. */
export function zonedTime(ymd: string, hhmm: string, tz: string): Date {
  const [y, m, d] = ymd.split("-").map(Number) as [number, number, number];
  const [hh, mm] = hhmm.split(":").map(Number) as [number, number];
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  let t = guess - offsetMinutes(new Date(guess), tz) * 60_000;
  t = guess - offsetMinutes(new Date(t), tz) * 60_000; // second pass handles DST edges
  return new Date(t);
}

const toMinutes = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  return h * 60 + m;
};

function addDays(ymd: string, n: number): { ymd: string; weekday: number } {
  const [y, m, d] = ymd.split("-").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d) + n * DAY);
  return { ymd: date.toISOString().slice(0, 10), weekday: date.getUTCDay() };
}

function isOpenDay(hours: Hours, ymd: string, weekday: number): boolean {
  return !hours.weekly[weekday]!.closed && !hours.holidays.includes(ymd);
}

/** The next scheduled opening strictly after `after`, ignoring any manual override. */
export function nextOpening(after: Date, hours: Hours): Date | null {
  const today = zonedParts(after, hours.timezone).ymd;
  for (let i = 0; i < 15; i++) {
    const { ymd, weekday } = addDays(today, i);
    if (!isOpenDay(hours, ymd, weekday)) continue;
    const openAt = zonedTime(ymd, hours.weekly[weekday]!.open, hours.timezone);
    if (openAt > after) return openAt;
  }
  return null;
}

export interface ShopStatus {
  open: boolean;
  /** When today's opening ends, if known. */
  closesAt: Date | null;
  /** When the shop next opens, if it's closed now. */
  nextOpenAt: Date | null;
  reason: "hours" | "override_open" | "override_closed" | "holiday" | "closed_day" | "outside_hours";
}

export function shopStatus(now: Date, hours: Hours): ShopStatus {
  const p = zonedParts(now, hours.timezone);
  const day = hours.weekly[p.weekday]!;
  const openToday = isOpenDay(hours, p.ymd, p.weekday);
  const withinHours = openToday && p.minutes >= toMinutes(day.open) && p.minutes < toMinutes(day.close);
  const closesToday = openToday ? zonedTime(p.ymd, day.close, hours.timezone) : null;

  if (hours.override === "open") {
    return { open: true, closesAt: withinHours ? closesToday : null, nextOpenAt: null, reason: "override_open" };
  }
  if (hours.override === "closed") {
    return { open: false, closesAt: null, nextOpenAt: nextOpening(now, hours), reason: "override_closed" };
  }
  if (withinHours) return { open: true, closesAt: closesToday, nextOpenAt: null, reason: "hours" };
  const reason = hours.holidays.includes(p.ymd) ? "holiday" : day.closed ? "closed_day" : "outside_hours";
  return { open: false, closesAt: null, nextOpenAt: nextOpening(now, hours), reason };
}

export interface DeliveryPlan {
  sameDay: boolean;
  /** When a later-day order will be prepared. */
  scheduledFor: Date | null;
  /** Shown to the customer, e.g. "within 30–45 minutes" or "after we open at 9:00 AM tomorrow". */
  etaText: string;
}

/**
 * Same-day delivery while the shop is open and the order arrives before the cut-off;
 * otherwise the order is prepared at the next opening.
 */
export function planDelivery(now: Date, s: Settings, band: string): DeliveryPlan {
  const status = shopStatus(now, s.hours);
  const cutoffMs = s.hours.sameDayCutoffMinutes * 60_000;
  if (status.open && (!status.closesAt || now.getTime() + cutoffMs <= status.closesAt.getTime())) {
    return { sameDay: true, scheduledFor: null, etaText: `within ${band}` };
  }
  const from = status.open && status.closesAt ? status.closesAt : now;
  const scheduledFor = status.open ? nextOpening(from, s.hours) : status.nextOpenAt;
  if (!scheduledFor) return { sameDay: false, scheduledFor: null, etaText: "when we next open" };
  return {
    sameDay: false,
    scheduledFor,
    etaText: `after we open at ${formatWhen(scheduledFor, now, s.hours.timezone)}, within ${band}`,
  };
}

/** "9:00 AM tomorrow", "9:00 AM today" or "9:00 AM on Mon, 27 Oct". */
export function formatWhen(d: Date, now: Date, tz: string): string {
  const time = new Intl.DateTimeFormat("en-IN", { timeZone: tz, hour: "numeric", minute: "2-digit", hour12: true })
    .format(d)
    .toUpperCase();
  const day = zonedParts(d, tz).ymd;
  const today = zonedParts(now, tz).ymd;
  if (day === today) return `${time} today`;
  if (day === addDays(today, 1).ymd) return `${time} tomorrow`;
  const date = new Intl.DateTimeFormat("en-IN", { timeZone: tz, weekday: "short", day: "numeric", month: "short" }).format(d);
  return `${time} on ${date}`;
}

/** "9:00 AM – 9:00 PM" for a weekday, or "Closed". */
export function hoursText(hours: Hours, weekday: number): string {
  const d = hours.weekly[weekday]!;
  if (d.closed) return "Closed";
  const fmt = (hhmm: string) => {
    const [h, m] = hhmm.split(":").map(Number) as [number, number];
    return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
  };
  return `${fmt(d.open)} – ${fmt(d.close)}`;
}
