// Baut eine portable Windows-EXE (Node Single Executable Application) nach dist/SQL-Schema-Viewer.exe.
// Server, Abhängigkeiten und Frontend werden eingebettet – die EXE läuft ohne installiertes Node.js.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const esbuild = require('esbuild');

const root = __dirname;
const build = path.join(root, 'build');
const dist = path.join(root, 'dist');
const exe = path.join(dist, 'SQL-Schema-Viewer.exe');

fs.rmSync(build, { recursive: true, force: true });
fs.mkdirSync(build, { recursive: true });
fs.mkdirSync(dist, { recursive: true });

// 1. Server samt node_modules in eine Datei bündeln
esbuild.buildSync({
  entryPoints: [path.join(root, 'server.js')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node' + process.versions.node.split('.')[0],
  outfile: path.join(build, 'server.bundle.js'),
  logLevel: 'warning',
});

// 2. Frontend-Dateien als SEA-Assets einbetten
const assets = { '/vendor/dagre.min.js': path.join(root, 'node_modules/dagre/dist/dagre.min.js') };
for (const f of fs.readdirSync(path.join(root, 'public'))) assets['/' + f] = path.join(root, 'public', f);

const seaConfig = path.join(build, 'sea-config.json');
fs.writeFileSync(seaConfig, JSON.stringify({
  main: path.join(build, 'server.bundle.js'),
  output: path.join(build, 'sea-prep.blob'),
  disableExperimentalSEAWarning: true,
  useCodeCache: false,
  assets,
}, null, 2));
execFileSync(process.execPath, ['--experimental-sea-config', seaConfig], { stdio: 'inherit' });

// 3. node.exe kopieren und Blob injizieren
fs.copyFileSync(process.execPath, exe);
execFileSync(process.execPath, [
  require.resolve('postject/dist/cli.js'), exe, 'NODE_SEA_BLOB', path.join(build, 'sea-prep.blob'),
  '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
], { stdio: 'inherit' });

fs.rmSync(build, { recursive: true, force: true });
console.log(`\nFertig: ${exe}`);
