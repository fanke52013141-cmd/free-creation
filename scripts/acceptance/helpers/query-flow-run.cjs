/* eslint-disable */
// 闭环验收助手：以 Electron-as-Node 读取隔离数据库的协调台账与固定资产。
// 用法：ELECTRON_RUN_AS_NODE=1 electron.exe query-flow-run.cjs <app.db 路径>
const D = require('better-sqlite3')
const db = new D(process.argv[2], { readonly: true })
const runRow = db
  .prepare('SELECT body_json FROM flow_coordination_runs ORDER BY rowid DESC LIMIT 1')
  .get()
const assets = db.prepare('SELECT node_id, port_id FROM flow_asset_versions ORDER BY rowid').all()
db.close()
console.log(JSON.stringify({ run: runRow ? JSON.parse(runRow.body_json) : null, assets }))