// MS SQL Schema Viewer – Express-Backend
// Verbindungsdaten werden pro Sitzung im Login eingegeben und nur serverseitig im Session-Speicher gehalten.
const express = require('express');
const session = require('express-session');
const sql = require('mssql');
const crypto = require('crypto');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(session({
  name: 'sqlviewer.sid',
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.COOKIE_SECURE === 'true', // hinter HTTPS-Proxy auf true setzen
    maxAge: 1000 * 60 * 60 * 4,
  },
}));
if (process.env.TRUST_PROXY === 'true') app.set('trust proxy', 1);

// Ein Verbindungspool pro Sitzung
const pools = new Map();

function buildConfig(c) {
  const cfg = {
    server: c.server,
    port: c.port ? parseInt(c.port, 10) : undefined,
    database: c.database || undefined,
    options: {
      encrypt: !!c.encrypt,
      trustServerCertificate: !!c.trustCert,
      instanceName: c.instance || undefined,
      enableArithAbort: true,
    },
    connectionTimeout: 15000,
    requestTimeout: 30000,
    pool: { max: 4, min: 0, idleTimeoutMillis: 60000 },
  };
  if (c.instance) delete cfg.port; // Named Instance -> SQL Browser löst den Port auf
  if (c.authType === 'ntlm') {
    cfg.authentication = {
      type: 'ntlm',
      options: { userName: c.user, password: c.password, domain: c.domain || '' },
    };
  } else {
    cfg.user = c.user;
    cfg.password = c.password;
  }
  return cfg;
}

async function getPool(req, database) {
  const s = req.session;
  if (!s.conn) throw Object.assign(new Error('Nicht angemeldet'), { status: 401 });
  const db = database || s.conn.database || 'master';
  const key = `${req.sessionID}|${db}`;
  let pool = pools.get(key);
  if (pool && pool.connected) return pool;
  pool = new sql.ConnectionPool(buildConfig({ ...s.conn, database: db }));
  await pool.connect();
  pools.set(key, pool);
  return pool;
}

async function closePools(sessionID) {
  for (const [key, pool] of pools) {
    if (key.startsWith(sessionID + '|')) {
      pools.delete(key);
      try { await pool.close(); } catch (_) {}
    }
  }
}

function requireAuth(req, res, next) {
  if (!req.session.conn) return res.status(401).json({ error: 'Nicht angemeldet' });
  next();
}

const wrap = fn => (req, res) => fn(req, res).catch(err => {
  console.error(err.message);
  res.status(err.status || 500).json({ error: err.message });
});

// ---------- Auth ----------
app.post('/api/login', wrap(async (req, res) => {
  const b = req.body || {};
  if (!b.server || !b.user) return res.status(400).json({ error: 'Server und Benutzer sind Pflichtfelder' });
  const conn = {
    server: String(b.server).trim(),
    port: b.port, instance: b.instance ? String(b.instance).trim() : '',
    database: b.database ? String(b.database).trim() : '',
    authType: b.authType === 'ntlm' ? 'ntlm' : 'sql',
    user: b.user, password: b.password || '', domain: b.domain || '',
    encrypt: !!b.encrypt, trustCert: !!b.trustCert,
  };
  // Testverbindung
  const test = new sql.ConnectionPool(buildConfig({ ...conn, database: conn.database || 'master' }));
  try {
    await test.connect();
    const r = await test.request().query('SELECT @@SERVERNAME AS name, @@VERSION AS version, SUSER_SNAME() AS login');
    await new Promise(ok => req.session.regenerate(ok));
    req.session.conn = conn;
    res.json({ ok: true, info: r.recordset[0] });
  } catch (e) {
    res.status(401).json({ error: 'Verbindung fehlgeschlagen: ' + e.message });
  } finally {
    try { await test.close(); } catch (_) {}
  }
}));

app.post('/api/logout', wrap(async (req, res) => {
  await closePools(req.sessionID);
  req.session.destroy(() => res.json({ ok: true }));
}));

app.get('/api/me', (req, res) => {
  const c = req.session.conn;
  if (!c) return res.status(401).json({ error: 'Nicht angemeldet' });
  res.json({ server: c.server + (c.instance ? '\\' + c.instance : ''), user: c.authType === 'ntlm' ? `${c.domain}\\${c.user}` : c.user, database: c.database });
});

// ---------- Metadaten ----------
app.get('/api/databases', requireAuth, wrap(async (req, res) => {
  const pool = await getPool(req, 'master');
  const r = await pool.request().query(`
    SELECT name FROM sys.databases
    WHERE state_desc = 'ONLINE' AND HAS_DBACCESS(name) = 1
    ORDER BY CASE WHEN database_id <= 4 THEN 1 ELSE 0 END, name`);
  res.json(r.recordset.map(x => x.name));
}));

app.get('/api/schema', requireAuth, wrap(async (req, res) => {
  const db = String(req.query.db || '');
  if (!db) return res.status(400).json({ error: 'Parameter db fehlt' });
  const pool = await getPool(req, db);

  const tables = await pool.request().query(`
    SELECT t.object_id, s.name AS [schema], t.name, t.type_desc AS kind,
           (SELECT SUM(p.rows) FROM sys.partitions p WHERE p.object_id = t.object_id AND p.index_id IN (0,1)) AS [rows]
    FROM sys.objects t JOIN sys.schemas s ON s.schema_id = t.schema_id
    WHERE t.type IN ('U','V') AND t.is_ms_shipped = 0
    ORDER BY s.name, t.name`);

  const columns = await pool.request().query(`
    SELECT c.object_id, c.column_id, c.name, ty.name AS type,
           c.max_length, c.precision, c.scale, c.is_nullable, c.is_identity, c.is_computed,
           CASE WHEN EXISTS (
             SELECT 1 FROM sys.index_columns ic JOIN sys.indexes i
               ON i.object_id = ic.object_id AND i.index_id = ic.index_id
             WHERE i.is_primary_key = 1 AND ic.object_id = c.object_id AND ic.column_id = c.column_id
           ) THEN 1 ELSE 0 END AS is_pk,
           dc.definition AS default_value
    FROM sys.columns c
    JOIN sys.types ty ON ty.user_type_id = c.user_type_id
    JOIN sys.objects o ON o.object_id = c.object_id AND o.type IN ('U','V') AND o.is_ms_shipped = 0
    LEFT JOIN sys.default_constraints dc ON dc.object_id = c.default_object_id
    ORDER BY c.object_id, c.column_id`);

  const fks = await pool.request().query(`
    SELECT fk.name, fk.parent_object_id AS from_id, fk.referenced_object_id AS to_id,
           fkc.constraint_column_id AS ord,
           pc.name AS from_col, rc.name AS to_col,
           fk.delete_referential_action_desc AS on_delete, fk.update_referential_action_desc AS on_update
    FROM sys.foreign_keys fk
    JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
    JOIN sys.columns pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id
    JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id
    ORDER BY fk.name, fkc.constraint_column_id`);

  const fmtType = c => {
    const t = c.type.toLowerCase();
    if (['varchar', 'char', 'varbinary', 'binary'].includes(t)) return `${t}(${c.max_length === -1 ? 'max' : c.max_length})`;
    if (['nvarchar', 'nchar'].includes(t)) return `${t}(${c.max_length === -1 ? 'max' : c.max_length / 2})`;
    if (['decimal', 'numeric'].includes(t)) return `${t}(${c.precision},${c.scale})`;
    if (['datetime2', 'time', 'datetimeoffset'].includes(t)) return `${t}(${c.scale})`;
    return t;
  };

  const byId = new Map();
  for (const t of tables.recordset) {
    byId.set(t.object_id, {
      id: String(t.object_id), schema: t.schema, name: t.name,
      kind: t.kind === 'VIEW' ? 'view' : 'table', rows: t.rows == null ? null : Number(t.rows), columns: [],
    });
  }
  const fkCols = new Set(fks.recordset.map(f => `${f.from_id}|${f.from_col}`));
  for (const c of columns.recordset) {
    const t = byId.get(c.object_id);
    if (!t) continue;
    t.columns.push({
      name: c.name, type: fmtType(c), nullable: !!c.is_nullable, identity: !!c.is_identity,
      computed: !!c.is_computed, pk: !!c.is_pk, fk: fkCols.has(`${c.object_id}|${c.name}`),
      default: c.default_value,
    });
  }

  const relMap = new Map();
  for (const f of fks.recordset) {
    if (!relMap.has(f.name)) relMap.set(f.name, {
      name: f.name, from: String(f.from_id), to: String(f.to_id), fromCols: [], toCols: [],
      onDelete: f.on_delete, onUpdate: f.on_update,
    });
    const r = relMap.get(f.name);
    r.fromCols.push(f.from_col); r.toCols.push(f.to_col);
  }

  res.json({ database: db, tables: [...byId.values()], relations: [...relMap.values()] });
}));

// Datenvorschau (nur lesend, Bezeichner werden über Objekt-ID aufgelöst)
app.get('/api/preview', requireAuth, wrap(async (req, res) => {
  const db = String(req.query.db || '');
  const id = parseInt(req.query.id, 10);
  const top = Math.min(Math.max(parseInt(req.query.top, 10) || 100, 1), 1000);
  if (!db || !id) return res.status(400).json({ error: 'Parameter fehlen' });
  const pool = await getPool(req, db);
  const meta = await pool.request().input('id', sql.Int, id).query(`
    SELECT QUOTENAME(s.name) + '.' + QUOTENAME(o.name) AS fullname
    FROM sys.objects o JOIN sys.schemas s ON s.schema_id = o.schema_id
    WHERE o.object_id = @id AND o.type IN ('U','V')`);
  if (!meta.recordset.length) return res.status(404).json({ error: 'Objekt nicht gefunden' });
  const r = await pool.request().query(`SELECT TOP (${top}) * FROM ${meta.recordset[0].fullname}`);
  const cols = r.recordset.columns ? Object.keys(r.recordset.columns) : (r.recordset[0] ? Object.keys(r.recordset[0]) : []);
  const rows = r.recordset.map(row => cols.map(c => {
    const v = row[c];
    if (v == null) return null;
    if (Buffer.isBuffer(v)) return `0x${v.subarray(0, 16).toString('hex').toUpperCase()}${v.length > 16 ? '…' : ''}`;
    if (v instanceof Date) return v.toISOString().replace('T', ' ').replace('Z', '');
    if (typeof v === 'object') return JSON.stringify(v);
    return v;
  }));
  res.json({ columns: cols, rows });
}));

// ---------- Frontend ----------
// Als portable EXE (Node SEA) sind die Frontend-Dateien in die EXE eingebettet.
let sea = null;
try { sea = require('node:sea'); if (!sea.isSea()) sea = null; } catch (_) {}

if (sea) {
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
  app.get(/.*/, (req, res, next) => {
    const key = req.path === '/' ? '/index.html' : req.path;
    let data;
    try { data = sea.getAsset(key); } catch (_) { return next(); }
    res.type(types[path.extname(key)] || 'application/octet-stream').send(Buffer.from(data));
  });
} else {
  app.get('/vendor/dagre.min.js', (req, res) => res.sendFile(path.join(__dirname, 'node_modules/dagre/dist/dagre.min.js')));
  app.use(express.static(path.join(__dirname, 'public')));
}

app.listen(PORT, () => {
  const url = `http://localhost:${PORT}`;
  console.log(`SQL Schema Viewer läuft auf ${url}`);
  if (sea) {
    console.log('Zum Beenden dieses Fenster schließen.');
    if (process.platform === 'win32' && process.env.NO_BROWSER !== 'true') {
      require('child_process').exec(`start "" "${url}"`);
    }
  }
}).on('error', err => {
  console.error(err.code === 'EADDRINUSE' ? `Port ${PORT} ist bereits belegt. Anderen Port über die Umgebungsvariable PORT wählen.` : err.message);
  if (sea) setTimeout(() => process.exit(1), 10000);
});
