export type LocalParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatter(timezone: string): Intl.DateTimeFormat {
  let f = formatterCache.get(timezone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    formatterCache.set(timezone, f);
  }
  return f;
}

export function localParts(timestamp: number, timezone: string): LocalParts {
  const values: Record<string, string> = {};
  for (const part of formatter(timezone).formatToParts(new Date(timestamp))) {
    if (part.type !== "literal") values[part.type] = part.value;
  }
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second),
  };
}

/** Convert a wall-clock time in an IANA zone to a Unix millisecond timestamp. */
export function zonedTimeToMs(parts: LocalParts, timezone: string): number {
  let guess = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  for (let i = 0; i < 3; i++) {
    const actual = localParts(guess, timezone);
    const actualAsUtc = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
      actual.second,
    );
    const wantedAsUtc = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
    );
    const correction = wantedAsUtc - actualAsUtc;
    if (correction === 0) break;
    guess += correction;
  }
  return guess;
}

export function dayKey(timestamp: number, timezone: string): string {
  const p = localParts(timestamp, timezone);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

export function hourOfDay(timestamp: number, timezone: string): number {
  return localParts(timestamp, timezone).hour;
}

export function formatTime(timestamp: number, timezone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

export function formatDateTime(timestamp: number, timezone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

export type ParsedReset = {
  resetAt: number;
  label: string;
  approximate: boolean;
};

/**
 * Parse Claude's limit text, for example:
 * "You've hit your 5-hour limit · resets 5:10pm (America/New_York)"
 * "You've hit your weekly limit · resets 1pm (America/New_York)"
 */
export function parseClaudeReset(
  text: string,
  hitAt: number,
  fallbackTimezone: string,
): ParsedReset | null {
  const match = text.match(
    /resets?\s+(?:on\s+)?(?:[A-Za-z]+,\s*)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)(?:\s*\(([^)]+)\))?/i,
  );
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2] ?? "0");
  const meridiem = match[3].toLowerCase();
  if (meridiem === "pm" && hour !== 12) hour += 12;
  if (meridiem === "am" && hour === 12) hour = 0;
  const timezone = match[4]?.trim() || fallbackTimezone;
  let event;
  try {
    event = localParts(hitAt, timezone);
  } catch {
    event = localParts(hitAt, fallbackTimezone);
  }
  let resetAt = zonedTimeToMs(
    {
      year: event.year,
      month: event.month,
      day: event.day,
      hour,
      minute,
      second: 0,
    },
    timezone,
  );
  if (resetAt <= hitAt) {
    const next = new Date(resetAt + 24 * 60 * 60 * 1000);
    const p = localParts(next.getTime(), timezone);
    resetAt = zonedTimeToMs(
      { year: p.year, month: p.month, day: p.day, hour, minute, second: 0 },
      timezone,
    );
  }
  const weekly = /weekly|7-day|seven-day/i.test(text);
  return {
    resetAt,
    label: text,
    approximate: weekly,
  };
}

export function relativeDuration(ms: number): string {
  const future = ms > 0;
  const abs = Math.abs(ms);
  const mins = Math.round(abs / 60_000);
  if (mins < 1) return future ? "under a minute" : "just now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  if (hours < 24) return rem ? `${hours}h ${rem}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const remH = hours % 24;
  return remH ? `${days}d ${remH}h` : `${days}d`;
}
