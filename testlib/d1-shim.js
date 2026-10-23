// A Cloudflare D1-compatible binding backed by sql.js (SQLite compiled to
// WebAssembly — no native build, runs the same on a dev Mac and in CI).
// Lets tests run the REAL migrations and the REAL functions/_lib/db.js
// against a real SQLite engine instead of mocking every query.
//
// Mirrors the D1 surface db.js uses: prepare(sql).bind(...).first()/all()/run(),
// batch([...]) (one transaction), exec(sql) for migration files. Like D1,
// foreign keys are enforced and binding `undefined` is an error.

const initSqlJs = require("sql.js");

function checkParams(params, sql){
  params.forEach((p, i) => {
    if(p === undefined) throw new Error("D1_TYPE_ERROR: Type 'undefined' not supported for value at index " + i + " in: " + sql.slice(0, 80));
  });
  return params.map(p => typeof p === "boolean" ? (p ? 1 : 0) : p);
}

function makeD1(SQL, raw){
  raw.run("PRAGMA foreign_keys = ON");

  function execute(sql, params){
    const stmt = raw.prepare(sql);
    try{
      stmt.bind(checkParams(params, sql));
      const rows = [];
      while(stmt.step()) rows.push(stmt.getAsObject());
      return rows;
    }finally{ stmt.free(); }
  }
  function meta(){
    const last = raw.exec("SELECT last_insert_rowid() AS id")[0].values[0][0];
    return { changes: raw.getRowsModified(), last_row_id: last };
  }
  function bound(sql, params){
    return {
      _sql: sql, _params: params,
      async first(col){ const r = execute(sql, params)[0]; return r === undefined ? null : (col ? r[col] : r); },
      async all(){ const results = execute(sql, params); return { results, success: true, meta: meta() }; },
      async run(){ execute(sql, params); return { success: true, meta: meta() }; },
    };
  }
  return {
    _raw: raw,
    prepare(sql){
      return Object.assign(bound(sql, []), { bind: (...params) => bound(sql, params) });
    },
    async batch(stmts){
      raw.run("SAVEPOINT d1_batch");
      try{
        const out = [];
        for(const s of stmts){ execute(s._sql, s._params); out.push({ success: true, meta: meta() }); }
        raw.run("RELEASE d1_batch");
        return out;
      }catch(e){ raw.run("ROLLBACK TO d1_batch"); raw.run("RELEASE d1_batch"); throw e; }
    },
    // Runs a whole .sql file atomically, like `wrangler d1 execute --file`.
    execFile(sqlText){
      raw.run("BEGIN");
      try{ raw.exec(sqlText); raw.run("COMMIT"); }
      catch(e){ raw.run("ROLLBACK"); throw e; }
    },
    // Synchronous convenience for assertions.
    q(sql, ...params){ return execute(sql, params); },
  };
}

async function createD1(){
  const SQL = await initSqlJs();
  return makeD1(SQL, new SQL.Database());
}

module.exports = { createD1 };
