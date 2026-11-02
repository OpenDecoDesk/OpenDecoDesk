const fs = require("fs");
const path = require("path");
const { networkFolder, networkFolderMessage } = require("./desktop/network-folder.js");

// The desktop program run from a shared or network folder on Windows (2026-11): Windows won't start
// its helper processes from one, and it closed with nothing on screen ("GPU process isn't usable").
// Found in Parallels, where Windows' Downloads is often the Mac's own, shared as \\Mac\Home\Downloads.
// It now checks where it is first and says what to do. desktop/network-folder.js, main.js, the
// build's file list, docs/desktop.md and desktop/RELEASE_NOTES.md.
const read = (p) => fs.readFileSync(path.join(__dirname, p), "utf8");
let pass = 0, fail = 0;
const ok = (d, c) => { console.log(d + ":", !!c); c ? pass++ : fail++; };

const local = (p) => p;   // a realpath that finds nothing new
const throws = () => { throw new Error("EPERM"); };

console.log("=== Which folders are shared or network ones ===");
ok("a Parallels shared folder (\\\\Mac\\Home\\Downloads\\…) is one", networkFolder("\\\\Mac\\Home\\Downloads\\OpenDecoDesk-Windows", local) === "\\\\Mac\\Home\\Downloads\\OpenDecoDesk-Windows");
ok("…and so is any \\\\server\\share, also written \\\\?\\UNC\\server\\share", networkFolder("\\\\nas\\apps\\OpenDecoDesk", local) && networkFolder("\\\\?\\UNC\\nas\\apps\\OpenDecoDesk", local) && networkFolder("\\\\?\\unc\\nas\\apps", local));
ok("a drive letter mapped to one (Y:\\…) is found through its real path", networkFolder("Y:\\Downloads\\OpenDecoDesk", () => "\\\\Mac\\Home\\Downloads\\OpenDecoDesk") === "\\\\Mac\\Home\\Downloads\\OpenDecoDesk");
ok("a folder on the computer's own disk isn't, nor its long \\\\?\\C:\\ or device \\\\.\\ forms",
  networkFolder("C:\\Users\\sam\\OpenDecoDesk", local) === null && networkFolder("\\\\?\\C:\\Users\\sam\\OpenDecoDesk", local) === null && networkFolder("\\\\.\\C:\\OpenDecoDesk", local) === null);
ok("a real path that can't be read is judged by the path alone", networkFolder("C:\\OpenDecoDesk", throws) === null && networkFolder("\\\\Mac\\Home\\OpenDecoDesk", throws) === "\\\\Mac\\Home\\OpenDecoDesk");
ok("the real fs.realpathSync.native is the default, and a Mac or Linux path is never one", networkFolder(__dirname) === null && networkFolder("/Applications/OpenDecoDesk.app/Contents/MacOS") === null);

console.log("\n=== What it says ===");
const msg = networkFolderMessage("\\\\Mac\\Home\\Downloads\\OpenDecoDesk-Windows", "C:\\Users\\sam");
ok("where it is, and why it can't run there", msg.includes("\\\\Mac\\Home\\Downloads\\OpenDecoDesk-Windows") && /shared or network folder/.test(msg) && /doesn't let it open its window/.test(msg));
ok("where to move it: a folder in the home folder, on the computer's own disk", msg.includes("C:\\Users\\sam\\OpenDecoDesk") && /own disk/.test(msg) && /OpenDecoDesk\.exe/.test(msg));
ok("that Parallels shares the Mac's folders, and that the data isn't in the program's folder", /Parallels/.test(msg) && /Downloads/.test(msg) && /data isn't kept in the program's folder/.test(msg));

console.log("\n=== The program ===");
const main = read("desktop/main.js");
const pkg = JSON.parse(read("desktop/package.json")).build;
ok("on Windows, packaged, it checks its own folder (the .exe's) before taking the one-copy lock",
  /const misplaced = process\.platform === "win32" && app\.isPackaged \? networkFolder\(path\.dirname\(process\.execPath\)\) : null;/.test(main) &&
  main.indexOf("const misplaced") < main.indexOf("requestSingleInstanceLock") && /const primary = !misplaced && app\.requestSingleInstanceLock\(\);/.test(main));
ok("…logs it, shows the message in an error box (which works before the program is ready) and quits",
  /if \(misplaced\) \{\n  log\("Can't run from a shared or network folder: " \+ misplaced\);\n  dialog\.showErrorBox\("OpenDecoDesk can't run from this folder", networkFolderMessage\(misplaced, app\.getPath\("home"\)\)\);\n  app\.exit\(1\);\n\}/.test(main));
ok("…and starts nothing once it's ready", /app\.whenReady\(\)\.then\(async \(\) => \{\n  if \(misplaced\) return;/.test(main));
ok("a helper process Windows won't start for another reason is written to the log", /app\.on\("child-process-gone", \(e, d\) => \{\n  if \(d\.reason === "launch-failed"\) log\(/.test(main));
ok("network-folder.js is in the build", pkg.files.includes("network-folder.js"));

console.log("\n=== The instructions ===");
const guide = read("docs/desktop.md"), notes = read("desktop/RELEASE_NOTES.md");
ok("the guide: unzip it on the computer's own disk, not a shared or network folder, with Parallels' shared folders as the example",
  /own disk \(say `C:\\Users\\<you>\\OpenDecoDesk`/.test(guide) && /Not a shared or network\n  folder/.test(guide) && /Parallels, Windows' Desktop, Documents and Downloads are often the Mac's own folders/.test(guide));
ok("the release notes say the same, and no longer suggest Documents (often the Mac's own in Parallels)",
  /own\n  disk \(say `C:\\Users\\<you>\\OpenDecoDesk`\)/.test(notes) && /Not a shared or network folder/.test(notes) && !/Documents\\OpenDecoDesk/.test(notes + guide));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
