-- Production run management: a design VERSION now records two required files, not one — the
-- native, editable design-software project file (Design file — .emb/.jdx/etc, what you'd open to
-- make an edit) and the actual stitch file the machine runs (Machine file — .dst/.exp/etc, what
-- "Send design to machine" sends). Previously one fileKey covered whichever
-- of the two happened to be uploaded, which meant "Send design to machine" had no reliable way to
-- know it had the right kind of file.
--
-- SQLite can't add two required, meaningfully-different columns and rename the old one away in
-- one ALTER — rebuild the table (no FKs reference `design_versions` from elsewhere, so this is a
-- plain rename/recreate/copy/drop; see 0006's header for the general pattern). Any
-- existing row's old fileKey is carried into machineFileKey (a stitch file is what would
-- have been uploaded first, in practice) and its designFileKey is left blank, flagging that a
-- re-upload of the native file is needed.
-- ===========================================================================

ALTER TABLE design_versions RENAME TO design_versions_old_0026;

CREATE TABLE design_versions (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  designId         INTEGER NOT NULL REFERENCES designs(id) ON DELETE CASCADE,
  designFileKey    TEXT NOT NULL DEFAULT '',
  designFileName   TEXT NOT NULL DEFAULT '',
  designFileExt    TEXT NOT NULL DEFAULT '',
  machineFileKey   TEXT NOT NULL DEFAULT '',
  machineFileName  TEXT NOT NULL DEFAULT '',
  machineFileExt   TEXT NOT NULL DEFAULT '',
  threadColorsJson TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(threadColorsJson)),
  notes            TEXT NOT NULL DEFAULT '',
  uploadedAt       TEXT NOT NULL,
  createdAt        TEXT NOT NULL
);

INSERT INTO design_versions (id, designId, machineFileKey, machineFileName, machineFileExt, threadColorsJson, notes, uploadedAt, createdAt)
  SELECT id, designId, fileKey, fileName, fileExt, threadColorsJson, notes, uploadedAt, createdAt FROM design_versions_old_0026;

DROP TABLE design_versions_old_0026;

CREATE INDEX IF NOT EXISTS idx_design_versions_design ON design_versions(designId, uploadedAt);
