// Windows can't start the program's helper processes (the ones that draw the window and show each
// page) from a shared or network folder: they run with fewer rights, and those rights don't reach
// the network. Chromium then gives up and closes with nothing on screen ("GPU process launch failed:
// error_code=18 … GPU process isn't usable. Goodbye."). In Parallels, Windows' Desktop, Documents
// and Downloads are often the Mac's own folders, shared as \\Mac\Home\… or as a drive letter. So on
// Windows the program checks where it is before anything else (main.js), and says what to do.

const fs = require("fs");
const path = require("path");

// \\server\share\…, or the same written \\?\UNC\server\share\…; not \\?\C:\… or \\.\… (local).
const NETWORK = /^(\\\\\?\\UNC\\|\\\\(?![?.]\\))/i;

// The network folder `dir` is in, or null. A drive letter mapped to a share (Y:\…) is found through
// its real path, which Windows gives as \\server\share\…; `realpath` is fs.realpathSync.native.
function networkFolder(dir, realpath = fs.realpathSync.native) {
  let real = null;
  try { real = realpath(dir); } catch (e) { /* unreadable: judge by the path alone */ }
  for (const p of [dir, real]) if (p && NETWORK.test(String(p))) return String(p);
  return null;
}

// What the program says when it is in one: where it is, and a folder on the computer's own disk to
// move it to (the home folder itself is never one of the folders Parallels shares).
function networkFolderMessage(dir, home) {
  return "It is in " + dir + ", a shared or network folder, and Windows doesn't let it open its window from there.\n\n" +
    "Move the OpenDecoDesk folder onto this computer's own disk, for example " + path.win32.join(home, "OpenDecoDesk") +
    ", and open OpenDecoDesk.exe from there.\n\n" +
    "In Parallels, Windows' Desktop, Documents and Downloads are often the Mac's own folders, shared over the network. " +
    "Your data isn't kept in the program's folder, so moving it changes nothing else.";
}

module.exports = { networkFolder, networkFolderMessage };
