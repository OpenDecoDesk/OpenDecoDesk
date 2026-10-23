/**
 * Decides whether a cron tick is the daily roll-up's moment.
 *
 * Cron Triggers run in UTC only, but the roll-up should arrive at the same LOCAL hour all year,
 * wherever the business is (and through daylight saving). So the Worker is woken every hour, on the
 * hour, and this check lets exactly one tick a day through: the one whose local hour is DIGEST_HOUR.
 *
 * The time zone is the install's one time zone — Global settings → Region, else the TIMEZONE
 * variable, else UTC (resolveTimeZone in db.js) — which the caller looks up and passes in. Without
 * one passed, the TIMEZONE variable is used, then UTC. An unknown time zone counts as UTC rather
 * than never sending. DIGEST_HOUR (plain variable, 0-23) defaults to 6.
 *
 * Two edge cases of "once a day", both on the day the clocks change and only when DIGEST_HOUR is
 * the hour that is skipped or repeated (1–2 AM in most zones): that day gets no roll-up, or two.
 */

export const DEFAULT_TIMEZONE = "UTC";
export const DEFAULT_DIGEST_HOUR = 6;

export function localHour(date, timeZone) {
  const fmt = (tz) => new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hourCycle: "h23" });
  let parts;
  try { parts = fmt(timeZone || DEFAULT_TIMEZONE).formatToParts(date); }
  catch { parts = fmt(DEFAULT_TIMEZONE).formatToParts(date); }
  return Number(parts.find(p => p.type === "hour").value);
}

export function digestHour(env) {
  const n = Number(env && env.DIGEST_HOUR);
  return Number.isInteger(n) && n >= 0 && n <= 23 ? n : DEFAULT_DIGEST_HOUR;
}

export function isDigestHour(env, date, timeZone) {
  return localHour(date, timeZone || (env && env.TIMEZONE)) === digestHour(env);
}
