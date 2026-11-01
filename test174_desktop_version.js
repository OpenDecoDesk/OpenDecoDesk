const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { JSDOM, ResourceLoader } = require("jsdom");
const { ADMIN_ORIGIN } = require("./testlib/hosts.js");
const { createD1 } = require("./testlib/d1-shim.js");
const { readSources, migrate } = require("./desktop/migrate.js");
const { displayVersion, toSemver, nextVersion } = require("./desktop/version.js");

// The desktop program's version (2026-11): the date of the release and that day's build number,
// YYYY.MM.DD.NN, worked out by the release workflow from the tags already there — nobody sets it.
// package.json carries it as semver (major YYYY, minor MM, patch DD × 100 + NN); the source keeps
// 0.0.0, shown as "dev". The window's title bar and, in the desktop edition only, a small line above
// the business's name in the admin's header show it. desktop/version.js, main.js, server.js,
// catalog.js, index.html and .github/workflows/desktop.yml; the real catalog.js and page in jsdom.
const read = (p) => fs.readFileSync(path.join(__dirname, p), "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
let pass = 0, fail = 0;
const ok = (d, c) => { console.log(d + ":", !!c); c ? pass++ : fail++; };

(async () => {
  console.log("=== The version and its package.json form ===");
  ok("2026.11.01.01 is 2026.11.101 in package.json, and reads back the same", toSemver("2026.11.01.01") === "2026.11.101" && displayVersion("2026.11.101") === "2026.11.01.01");
  ok("…a second release that day is 2026.11.102; the last day of the year 2026.12.3199 for build 99", toSemver("2026.11.01.02") === "2026.11.102" && toSemver("2026.12.31.99") === "2026.12.3199" && displayVersion("2026.12.3199") === "2026.12.31.99");
  let roundTrip = true;
  for (let m = 1; m <= 12; m++) for (let d = 1; d <= 31; d++) for (const n of [1, 9, 10, 42, 99]) {
    const v = "2027." + String(m).padStart(2, "0") + "." + String(d).padStart(2, "0") + "." + String(n).padStart(2, "0");
    const s = toSemver(v);
    if (!s || !/^\d+\.\d+\.\d+$/.test(s) || /\.0\d/.test(s) || displayVersion(s) !== v) roundTrip = false;
  }
  ok("every day and build number maps to a valid semver (no leading zeros) and back", roundTrip);
  ok("the Windows file version needs each part under 65536: the largest patch is 3199", Number(toSemver("2099.12.31.99").split(".")[2]) === 3199);
  ok("the source's 0.0.0, a missing version and the old 0.1.1 all show as dev", displayVersion("0.0.0") === "dev" && displayVersion("") === "dev" && displayVersion(undefined) === "dev" && displayVersion("0.1.1") === "dev");
  ok("…and so does anything that isn't a real date and build", ["2026.13.101", "2026.11.3201", "2026.11.100", "2026.0.101", "2026.11.99"].every(v => displayVersion(v) === "dev"));
  ok("a version that isn't one has no package.json form", [null, "", "dev", "2026.11.1.1", "2026.13.01.01", "2026.11.32.01", "2026.11.01.00", "26.11.01.01"].every(v => toSemver(v) === null));

  console.log("\n=== The next release's version, from the tags ===");
  const nov1 = new Date("2026-11-01T15:00:00Z");
  ok("the first release of a day is build 01 (the old desktop-v0.1.0 and desktop-v0.1.1 don't count)", nextVersion(["desktop-v0.1.0", "desktop-v0.1.1"], nov1) === "2026.11.01.01" && nextVersion([], nov1) === "2026.11.01.01");
  ok("…the next one after the day's highest", nextVersion(["desktop-v2026.11.01.01", "desktop-v2026.11.01.03", "desktop-v2026.11.01.02"], nov1) === "2026.11.01.04");
  ok("…another day's builds don't count", nextVersion(["desktop-v2026.10.31.07", "desktop-v2026.11.02.05"], nov1) === "2026.11.01.01");
  ok("…nor tags not in the full pattern (a single digit, an extra part, another app's prefix)", nextVersion(["desktop-v2026.11.01.5", "desktop-v2026.11.01.05.1", "desktop-v2026.11.01.05-rc", "stitch-v2026.11.01.08", "v2026.11.01.09"], nov1) === "2026.11.01.01");
  ok("the date is UTC: 8 pm in New York on Oct 31 is already Nov 1", nextVersion([], new Date("2026-10-31T20:30:00-04:00")) === "2026.11.01.01");
  let err = null; try { nextVersion(["desktop-v2026.11.01.99"], nov1); } catch (e) { err = e; }
  ok("a hundredth release in one day is refused rather than wrapping round", err && /99 releases/.test(err.message));
  const out = execFileSync(process.execPath, [path.join(__dirname, "desktop/version.js"), "next"], {
    input: "abc\trefs/tags/desktop-v0.1.1\ndef\trefs/tags/desktop-v" + nextVersion([]).slice(0, 10) + ".01\n" }).toString();
  ok("the workflow's command reads git ls-remote's list and prints the outputs", out === "version=" + nextVersion([]).slice(0, 10) + ".02\nsemver=" + toSemver(nextVersion([]).slice(0, 10) + ".02") + "\n");

  console.log("\n=== The program ===");
  const pkg = JSON.parse(read("desktop/package.json")), lock = JSON.parse(read("desktop/package-lock.json"));
  ok("the source's package.json is 0.0.0 (dev), and so is its lock file", pkg.version === "0.0.0" && lock.version === "0.0.0" && lock.packages[""].version === "0.0.0");
  ok("version.js goes into the build with the program", pkg.build.files.includes("version.js"));
  const main = read("desktop/main.js"), server = read("desktop/server.js");
  ok("the window's title is OpenDecoDesk and the version", /const VERSION = displayVersion\(app\.getVersion\(\)\);/.test(main) && /title: "OpenDecoDesk " \+ VERSION,/.test(main));
  ok("…and the page's own title doesn't replace it", /win\.on\("page-title-updated", \(e\) => e\.preventDefault\(\)\);/.test(main));
  ok("…the log says which version started", /log\("OpenDecoDesk " \+ VERSION \+ " starting/.test(main) && !/app\.getVersion\(\) \+/.test(main));
  ok("the Worker is given the version (DESKTOP_VERSION) with EDITION=desktop", /bindings: \{ EDITION: "desktop", DESKTOP_VERSION: displayVersion\(require\("\.\/package\.json"\)\.version\),/.test(server));

  console.log("\n=== The release workflow ===");
  const wf = read(".github/workflows/desktop.yml");
  const job = (name) => wf.slice(wf.indexOf("\njobs:\n")).split(/\n(?=  [a-z]+:\n)/).find(j => j.startsWith("  " + name + ":\n")) || "";
  ok("run by hand only: no tag trigger, no version typed in", /on:\n  workflow_dispatch:\n    inputs:\n      release:/.test(wf) && !/\n  push:/.test(wf) && !/tags: \[/.test(wf) && !/require\('\.\/desktop\/package\.json'\)\.version/.test(wf));
  ok("a first job works out the version from the tags, and only on main", /\n  version:\n    runs-on: ubuntu-latest/.test(wf) && /git ls-remote --tags --refs origin \| node desktop\/version\.js next \| tee -a "\$GITHUB_OUTPUT"/.test(job("version")) &&
    /"\$GITHUB_REF" != "refs\/heads\/main"/.test(job("version")) && /version=dev\\nsemver=0\.0\.0/.test(job("version")));
  ok("each build stamps it into package.json before electron-builder, with the Mac's and Windows' versions", /  build:\n    needs: version\n/.test(wf) &&
    job("build").indexOf('npm version "$SEMVER" --no-git-tag-version') > 0 && job("build").indexOf('npm version "$SEMVER"') < job("build").indexOf("npx electron-builder") &&
    /npm pkg set build\.buildVersion="\$SEMVER" build\.mac\.bundleShortVersion="\$SEMVER"/.test(job("build")) && /if: needs\.version\.outputs\.release == 'true'/.test(job("build")));
  ok("the release is desktop-v<version>, titled OpenDecoDesk Desktop <version>, with the website's file names and the notes", /gh release create "desktop-v\$VERSION"/.test(job("release")) &&
    /--title "OpenDecoDesk Desktop \$VERSION" --notes-file desktop\/RELEASE_NOTES\.md/.test(job("release")) && /needs: \[version, build\]/.test(job("release")) &&
    ["OpenDecoDesk-Windows.zip", "OpenDecoDesk-macOS-AppleSilicon.zip", "OpenDecoDesk-macOS-Intel.zip"].every(n => job("release").includes("release/" + n)));
  ok("…and no longer asks for a bumped package.json or refuses a version", !/bump|GITHUB_REF_NAME|already released/i.test(wf));
  ok("every action is pinned to a commit", [...wf.matchAll(/uses: (\S+)/g)].length >= 6 && [...wf.matchAll(/uses: (\S+)/g)].every(m => /@[0-9a-f]{40}$/.test(m[1])));
  const docs = read("docs/desktop.md");
  ok("docs/desktop.md says how to release and what the version is", /\*\*Actions → Desktop builds → Run workflow\*\*, on `main`, with \*\*Publish a release\*\*\s+ticked/.test(docs) &&
    /`YYYY\.MM\.DD\.NN`/.test(docs) && /`2026\.11\.01\.01` is `2026\.11\.101`/.test(docs) && !/set the new `version` in `desktop\/package\.json`/.test(docs) && !/push a tag/.test(docs));
  ok("…and the release notes state no version of their own", !/New in \d+\.\d+/.test(read("desktop/RELEASE_NOTES.md")));

  console.log("\n=== The admin's answer and header ===");
  const d1 = await createD1();
  await migrate(d1, readSources(__dirname));
  const catalog = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/db.js")) + "\n" +
    "const getCatalogData = async (env) => ({ subdomainMap: {}, ...(await getPublicCatalogData(env.DB)) });\n" + strip(read("functions/api/catalog.js")) + "\nreturn onRequestGet;")();
  const answer = async (env, origin) => JSON.parse(await (await catalog({ request: { url: origin + "/api/catalog" }, env })).text());
  const desk = { DB: d1, EDITION: "desktop", DESKTOP_VERSION: "2026.11.01.01" };
  let a = await answer(desk, "http://localhost:47830");
  ok("the desktop admin's answer carries the version next to edition", a.status === "admin" && a.edition === "desktop" && a.version === "2026.11.01.01");
  a = await answer({ DB: d1, EDITION: "desktop" }, "http://localhost:47830");
  ok("…dev when the program didn't say", a.version === "dev");
  a = await answer({ DB: d1, DESKTOP_VERSION: "2026.11.01.01" }, ADMIN_ORIGIN);
  ok("a cloud install's admin answer has no edition and no version", a.status === "admin" && a.edition === undefined && a.version === undefined);

  const page = read("public/index.html");
  class L extends ResourceLoader { fetch(url, o){
    if (url.includes("/admin.js")) return Promise.resolve(Buffer.from("window.adminRoute = async () => {};"));
    const local = new URL(url).pathname.match(/^\/vendor\/fonts\/[a-z0-9.-]+$/);
    return local ? Promise.resolve(fs.readFileSync(__dirname + "/public" + local[0])) : super.fetch(url, o); } }
  const open = async (env, origin, desktop) => {
    const dom = new JSDOM(page, { runScripts: "dangerously", resources: new L(), url: origin + "/", pretendToBeVisual: true,
      beforeParse(win){
        win.fetch = async (url) => {
          if (String(url).includes("/api/catalog")) { const res = await catalog({ request: { url: origin + "/api/catalog" }, env }); const body = JSON.parse(await res.text()); return { ok: res.ok, status: res.status, json: async () => body }; }
          return { ok: true, status: 200, json: async () => ({ status: "error", message: "n/a" }) };
        };
        if (desktop) win.oddDesktop = { edition: "desktop", firstRunKey: async () => null };
        win.confirm = () => true;
        win.CSS = win.CSS || { escape: (x) => String(x) };
      } });
    for (let i = 0; i < 100 && !dom.window.document.getElementById("brandName").textContent; i++) await new Promise(r => setTimeout(r, 20));
    await new Promise(r => setTimeout(r, 100));
    return dom.window;
  };
  let w = await open(desk, "http://localhost:47830", true);
  let mark = w.document.getElementById("desktopMark"), brand = w.document.getElementById("brandName");
  ok("in the desktop program, a line above the business's name: the mark, OpenDecoDesk, the version", mark && mark.nextElementSibling === brand && mark.parentNode.className === "brand" &&
    mark.querySelector("img").getAttribute("src") === "/images/icon.svg" && mark.querySelector("img").getAttribute("alt") === "" && mark.querySelector("b").textContent === "OpenDecoDesk" &&
    mark.querySelector("span").textContent === "2026.11.01.01");
  ok("…small and grey, so the business's name stays the heading", /\.desktop-mark\{[^}]*font-size:12px;[^}]*\}/.test(page) && /\.desktop-mark img\{width:18px; height:18px;/.test(page) && /\.desktop-mark b\{font-weight:600;\}/.test(page) &&
    /\.desktop-mark span\{color:var\(--dim\);\}/.test(page) && /\.brand\{[^}]*font-size:20px;/.test(page));
  w.close();
  w = await open({ ...desk, DESKTOP_VERSION: '<img src=x onerror="window.hit=1">' }, "http://localhost:47830", true);
  mark = w.document.getElementById("desktopMark");
  ok("the version is shown as text, never as markup", mark && mark.querySelectorAll("img").length === 1 && /<img src=x/.test(mark.querySelector("span").textContent) && !w.hit);
  w.close();
  w = await open({ DB: d1, DESKTOP_VERSION: "2026.11.01.01" }, ADMIN_ORIGIN, false);
  ok("a cloud install's admin has no such line", w.eval("siteEdition") === "" && !w.document.getElementById("desktopMark") && !w.document.querySelector(".desktop-mark"));
  w.close();

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
