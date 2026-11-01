// The program's version: the date of its release and that day's build number, YYYY.MM.DD.NN (the
// UTC date; 2026.11.01.01, and 2026.11.01.02 for a second release that day). Nobody sets it by
// hand: the release workflow (.github/workflows/desktop.yml) works it out from the tags already
// there with `node desktop/version.js next`, and stamps it into package.json before building.
//
// npm and electron-builder need a semver "version", so package.json carries it as
//   major = YYYY, minor = MM, patch = DD × 100 + NN        2026.11.01.01 → 2026.11.101
// which reads back the same way (displayVersion). The repository's own package.json keeps 0.0.0:
// a copy run from the source, or a build that isn't a release, shows "dev".

const DEV = "dev";
const TAG_PREFIX = "desktop-v";
const two = (n) => String(n).padStart(2, "0");

// package.json's version → what the window and the admin show: "2026.11.01.01", or "dev".
function displayVersion(semver) {
  const m = /^(\d{4})\.(\d{1,2})\.(\d{3,4})$/.exec(String(semver || "").trim());
  if (!m) return DEV;
  const month = Number(m[2]), day = Math.floor(Number(m[3]) / 100), build = Number(m[3]) % 100;
  if (month < 1 || month > 12 || day < 1 || day > 31 || build < 1) return DEV;
  return m[1] + "." + two(month) + "." + two(day) + "." + two(build);
}

// "2026.11.01.01" → "2026.11.101", for package.json. null for anything else.
function toSemver(version) {
  const m = /^(\d{4})\.(\d{2})\.(\d{2})\.(\d{2})$/.exec(String(version || ""));
  if (!m) return null;
  const semver = m[1] + "." + Number(m[2]) + "." + (Number(m[3]) * 100 + Number(m[4]));
  return displayVersion(semver) === version ? semver : null;   // a real month, day and build number
}

// The next release's version, from the names of the tags already there: today's UTC date, and the
// build after the day's highest desktop-v<date>.NN (01 when there is none). Other tags, such as
// the earlier desktop-v0.1.1, don't count.
function nextVersion(tags, now = new Date()) {
  const day = now.toISOString().slice(0, 10).replace(/-/g, ".");
  const builds = (tags || []).map(t => new RegExp("^" + TAG_PREFIX + day.replace(/\./g, "\\.") + "\\.(\\d{2})$").exec(String(t).trim()))
    .filter(Boolean).map(m => Number(m[1]));
  const next = Math.max(0, ...builds) + 1;
  if (next > 99) throw new Error("There have been 99 releases today already.");
  return day + "." + two(next);
}

module.exports = { DEV, TAG_PREFIX, displayVersion, toSemver, nextVersion };

// `git ls-remote --tags --refs origin | node desktop/version.js next` prints the next release's
// version and its package.json form, as the workflow's outputs (version=…, semver=…).
if (require.main === module && process.argv[2] === "next") {
  const tags = require("fs").readFileSync(0, "utf8").split("\n").map(l => l.trim().split(/\s+/).pop() || "").map(t => t.replace(/^refs\/tags\//, "")).filter(Boolean);
  const version = nextVersion(tags);
  console.log("version=" + version + "\nsemver=" + toSemver(version));
}
