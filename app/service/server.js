/*
 * Lightkeeper settings server.
 *
 * Serves the settings page and the config the Home reads, on port 8090, to the
 * TV itself and its local network only. Started and kept running by the boot
 * hook (lightkeeper-init). It runs no command it is sent: the only programs it
 * starts are luna-send, with calls written here, and GlassHouse's tvwebctl.
 *
 *   node server.js              serve
 *   node server.js --uninstall  put the remote keys back, remove the hook,
 *                               the settings and the app
 *
 * Strict ES5: it runs on the TV's own node, which is 0.12 on webOS 4.
 */
'use strict';
var http = require('http');
var fs = require('fs');
var path = require('path');
var os = require('os');
var net = require('net');
var crypto = require('crypto');
var execFile = require('child_process').execFile;
var spawn = require('child_process').spawn;

var VERSION = '1.0.0';
var APP_ID = 'io.github.chiotas.lightkeeper';
var PORT = +process.env.LIGHTKEEPER_PORT || 8090;
var HERE = __dirname;
var APP_DIR = path.dirname(HERE);
// Each path can be moved by an environment variable, which only the tests set.
var DATA = process.env.LIGHTKEEPER_DATA || '/var/lib/lightkeeper';
var TVWEB = process.env.LIGHTKEEPER_TVWEB || '/var/lib/tvweb';
var HOOK = process.env.LIGHTKEEPER_HOOK || '/var/lib/webosbrew/init.d/60-lightkeeper';
var LUNA_SEND = process.env.LIGHTKEEPER_LUNA_SEND || '/usr/bin/luna-send';
var KEY_FILTERS = process.env.LIGHTKEEPER_KEY_FILTERS || '/usr/lib/qt5/qml/KeyFilters';
var CONFIG = path.join(DATA, 'config.json');
var BACKGROUND = path.join(DATA, 'background.jpg');
// The backgrounds the app carries, by id, from backgrounds/index.json.
var PRESETS = (function () {
  try { return JSON.parse(fs.readFileSync(path.join(APP_DIR, 'backgrounds', 'index.json'), 'utf8')).map(function (b) { return b.id; }); }
  catch (e) { return ['godrevy']; }
})();

var MAX_JSON = 64 * 1024;
// When this server started: the Home asks again for what failed while it was down.
var STARTED = Date.now();
var MAX_IMAGE = 12 * 1024 * 1024;
var MAX_TILES = 12;

// GlassHouse's key filter (lib/remotekeys.js): what each key opens is the
// configd value glasshouse.remoteKeys, kept in remotekeys.json beside it.
var REMOTE_KEYS = path.join(TVWEB, 'remotekeys.json');
var REMOTE_KEYS_VALUE = 'glasshouse.remoteKeys';
var FILTER_FILE = path.join(TVWEB, 'remotekeys-filter.js');
var CHAIN = 'com.webos.surfacemanager.keyFilters';
// The keys GlassHouse's JavaScript filter can change, offered where this TV's
// own filter files name them. Home is GlassHouse's `home` entry.
var KEYS = [
  { key: 'netflix', symbol: 'Key_webOS_Netflix', title: 'Netflix' },
  { key: 'amazon', symbol: 'Key_webOS_Amazon', title: 'Prime Video' },
  { key: 'disneyplus', symbol: 'Key_webOS_Disneyplus', title: 'Disney+' },
  { key: 'lgchannels', symbol: 'Key_webOS_LGChannels', title: 'LG Channels' },
  { key: 'rakutentv', symbol: 'Key_webOS_RakutenTV', title: 'Rakuten TV' },
  { key: 'apps', symbol: 'Key_webOS_Apps', title: 'Apps' },
  { key: 'guide', symbol: 'Key_webOS_TVGuide', title: 'Guide' },
  { key: 'input', symbol: 'Key_webOS_InputSource', title: 'Input' },
  { key: 'livetv', symbol: 'Key_webOS_InputTV', title: 'TV' },
  { key: 'info', symbol: 'Key_webOS_Info', title: 'Info' },
  { key: 'red', symbol: 'Key_webOS_Red', title: 'Red' },
  { key: 'green', symbol: 'Key_webOS_Green', title: 'Green' },
  { key: 'yellow', symbol: 'Key_webOS_Yellow', title: 'Yellow' },
  { key: 'blue', symbol: 'Key_webOS_Blue', title: 'Blue' }
];

// The tiles a first start picks, those of them this TV has, in this order.
var USUAL_APPS = ['netflix', 'amazon', 'youtube.leanback.v4', 'com.disney.disneyplus-prod',
  'cdp-30', 'spotify-beehive', 'com.apple.appletv'];

var DEFAULTS = {
  clock: '24',
  units: 'c',
  weather: null,
  tiles: null,
  tileStyle: 'text',
  preset: 'godrevy',
  background: { custom: false, rev: 0 },
  veil: 80,
  key: 'home',
  openAtPowerOn: true,
  pin: null
};

/* ---------- small helpers ---------- */

function log(text) { console.log(new Date().toISOString() + ' ' + text); }

function has(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }

function copy(v) { return JSON.parse(JSON.stringify(v)); }

// Written beside and renamed into place, so a power cut never leaves half a file.
function writeAtomic(file, data, mode) {
  var tmp = file + '.tmp';
  fs.writeFileSync(tmp, data, { mode: mode || 384 });
  fs.renameSync(tmp, file);
}

function rmrf(p) {
  var st;
  try { st = fs.lstatSync(p); } catch (e) { return; }
  if (st.isDirectory()) {
    fs.readdirSync(p).forEach(function (f) { rmrf(path.join(p, f)); });
    fs.rmdirSync(p);
  } else {
    fs.unlinkSync(p);
  }
}

/* ---------- luna ---------- */

// One call at a time: node 0.12 has frozen with several luna-send children
// starting together (GlassHouse, lib/luna.js). cb(reply) with null on failure.
var lunaQueue = [];
function luna(uri, params, cb) {
  lunaQueue.push({ uri: uri, params: params, cb: cb || function () {}, retried: false });
  if (lunaQueue.length === 1) lunaNext();
}

function lunaNext() {
  var job = lunaQueue[0];
  if (!job) return;
  execFile(LUNA_SEND, ['-n', '1', '-w', '8000', 'luna://' + job.uri, JSON.stringify(job.params)],
    { timeout: 10000, maxBuffer: 4 * 1024 * 1024 }, function (err, stdout) {
      // A child killed by a signal nobody sent died before reaching luna-send
      // (seen with node 8 on webOS 6.5): safe to run once more.
      if (err && err.signal && !err.killed && !job.retried) {
        job.retried = true;
        return lunaNext();
      }
      lunaQueue.shift();
      var r = null;
      try { r = JSON.parse(String(stdout)); } catch (e) {}
      lunaNext();
      job.cb(r && r.returnValue !== false ? r : null);
    });
}

/* ---------- config ---------- */

var config = null;

function loadConfig() {
  var c = copy(DEFAULTS);
  try {
    var saved = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
    Object.keys(DEFAULTS).forEach(function (k) { if (has(saved, k)) c[k] = saved[k]; });
  } catch (e) {}
  return c;
}

// Pretty-printed: the boot hook reads "openAtPowerOn": true and "key": "home" with grep.
function saveConfig() {
  if (!fs.existsSync(DATA)) fs.mkdirSync(DATA, 448);
  writeAtomic(CONFIG, JSON.stringify(config, null, 2) + '\n');
}

// What the Home and the page see: everything but the PIN.
function publicConfig() {
  var c = copy(config);
  delete c.pin;
  c.pinSet = !!config.pin;
  c.version = VERSION;
  c.address = lanAddress();
  c.port = PORT;
  c.saverPausedUntil = saverUntil > Date.now() ? saverUntil : 0;
  c.started = STARTED;
  return c;
}

/*
 * The screen saver paused for a while: the TV asks every client registered
 * with registerScreenSaverRequest before it starts the screen saver, and one
 * answering ack false keeps it off. Until saverUntil, then LG's again. Held in
 * memory only, so a restart of the TV ends it too: an OLED should not show a
 * still picture for long.
 */
var saverUntil = 0, saverChild = null, saverTimer = null;

function pauseSaver(ms) {
  saverUntil = ms ? Date.now() + ms : 0;
  clearTimeout(saverTimer);
  if (!ms) {
    if (saverChild) saverChild.kill();
    return;
  }
  saverTimer = setTimeout(function () { pauseSaver(0); }, ms);
  // A screen saver already on goes away too: it takes the first key it gets, so a
  // Back sent only while it shows reaches nothing behind it (as GlassHouse does).
  luna('com.webos.service.tvpower/power/getPowerState', {}, function (r) {
    if (r && r.state === 'Screen Saver') luna('com.webos.service.networkinput/test/sendKeyCode', { keyCode: 412 });
  });
  if (saverChild) return;
  var child = saverChild = spawn(LUNA_SEND, ['-i', 'luna://com.webos.service.tvpower/power/registerScreenSaverRequest',
    JSON.stringify({ subscribe: true, clientName: APP_ID })], { stdio: ['ignore', 'pipe', 'ignore'] });
  var rest = '';
  child.stdout.on('data', function (d) {
    var lines = (rest + d).split('\n');
    rest = lines.pop();
    lines.forEach(function (l) {
      var ts = /"timestamp"\s*:\s*(\d+)/.exec(l);
      if (ts) {
        luna('com.webos.service.tvpower/power/responseScreenSaverRequest',
          { clientName: APP_ID, ack: Date.now() >= saverUntil, timestamp: +ts[1] });
      }
    });
  });
  child.on('exit', function () {
    if (saverChild === child) saverChild = null;
    if (Date.now() < saverUntil) setTimeout(function () { if (!saverChild && Date.now() < saverUntil) pauseSaver(saverUntil - Date.now()); }, 5000);
  });
}

var ID_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/;
// The devices an HDMI input can be set to, as in logos.js.
var DEVICES = ['ps5', 'ps4', 'xboxseries', 'xbox', 'switch2', 'switch', 'steamdeck', 'appletv', 'shield', 'chromecast', 'googletv', 'firetv', 'console', 'hdmi'];

function str(v, max) {
  return typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, '').replace(/^\s+|\s+$/g, '').slice(0, max) : '';
}

function num(v, min, max) { return typeof v === 'number' && isFinite(v) && v >= min && v <= max; }

/*
 * Checks a change to the config, field by field: an unknown field or a value
 * out of range refuses the whole change. Returns the cleaned change, or a
 * string saying what is wrong.
 */
function validate(body, keyNames) {
  var out = {};
  var fields = Object.keys(body);
  for (var i = 0; i < fields.length; i++) {
    var k = fields[i], v = body[k];
    if (k === 'clock') { if (v !== '24' && v !== '12') return 'clock'; out[k] = v; }
    else if (k === 'units') { if (v !== 'c' && v !== 'f') return 'units'; out[k] = v; }
    else if (k === 'tileStyle') { if (['text', 'logo', 'icon'].indexOf(v) === -1) return 'tileStyle'; out[k] = v; }
    else if (k === 'veil') { if (!num(v, 0, 100)) return 'veil'; out[k] = Math.round(v); }
    else if (k === 'openAtPowerOn') { if (typeof v !== 'boolean') return 'openAtPowerOn'; out[k] = v; }
    else if (k === 'preset') { if (PRESETS.indexOf(v) === -1) return 'preset'; out[k] = v; }
    else if (k === 'key') {
      if (v !== 'none' && v !== 'home' && keyNames.indexOf(v) === -1) return 'key';
      out[k] = v;
    } else if (k === 'weather') {
      if (v === null) { out[k] = null; continue; }
      if (!v || typeof v !== 'object' || !num(v.lat, -90, 90) || !num(v.lon, -180, 180) || !str(v.name, 80)) return 'weather';
      out[k] = { name: str(v.name, 80), lat: v.lat, lon: v.lon };
    } else if (k === 'tiles') {
      if (Object.prototype.toString.call(v) !== '[object Array]' || v.length > MAX_TILES) return 'tiles';
      var tiles = [], seen = {};
      for (var j = 0; j < v.length; j++) {
        var t = v[j];
        if (!t || typeof t !== 'object' || typeof t.id !== 'string' || !ID_RE.test(t.id) || seen[t.id] || !str(t.title, 40)) return 'tiles';
        seen[t.id] = true;
        var tile = { id: t.id, title: str(t.title, 40) };
        if (t.device !== undefined) {
          if (!isInput(t.id) || DEVICES.indexOf(t.device) === -1) return 'tiles';
          tile.device = t.device;
        }
        tiles.push(tile);
      }
      out[k] = tiles;
    } else {
      return k;
    }
  }
  return out;
}

/* ---------- PIN ---------- */

function pinHash(pin, salt) { return crypto.createHash('sha256').update(salt + ':' + pin).digest('hex'); }

// Compared in time that depends only on the length: node 0.12 has no timingSafeEqual.
function same(a, b) {
  var diff = a.length ^ b.length;
  for (var i = 0; i < b.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Five wrong PINs in a row lock the page for a minute, for everyone.
var pinFails = 0, pinLockedUntil = 0;

function pinOk(req) {
  if (!config.pin) return true;
  if (Date.now() < pinLockedUntil) return false;
  var given = String(req.headers['x-lightkeeper-pin'] || '');
  if (given && same(pinHash(given, config.pin.salt), config.pin.hash)) { pinFails = 0; return true; }
  if (given && ++pinFails >= 5) { pinFails = 0; pinLockedUntil = Date.now() + 60000; }
  return false;
}

/* ---------- what the TV has ---------- */

var appsCache = null, appsAt = 0;

function listApps(cb) {
  if (appsCache && Date.now() - appsAt < 60000) return cb(appsCache);
  luna('com.webos.applicationManager/listApps', {}, function (r) {
    if (r && r.apps && r.apps.length) { appsCache = r.apps; appsAt = Date.now(); }
    cb(r && r.apps && r.apps.length ? r.apps : appsCache);
  });
}

function isInput(id) { return /^com\.webos\.app\.(hdmi|livetv$)/.test(id); }

// The apps a tile can open: those on the Home screen, by title.
function appChoices(apps) {
  return (apps || []).filter(function (a) {
    return a && ID_RE.test(a.id || '') && a.visible !== false && a.id !== APP_ID &&
      !isInput(a.id) && !/^com\.webos\.app\.container/.test(a.id);
  }).map(function (a) { return { id: a.id, title: a.title || a.id }; })
    .sort(function (x, y) { return x.title.toLowerCase() < y.title.toLowerCase() ? -1 : 1; });
}

// The HDMI inputs by the names given them on the TV, then Live TV.
function inputChoices(apps, cb) {
  luna('com.webos.service.eim/getAllInputStatus', {}, function (r) {
    var out = [];
    ((r && r.devices) || []).forEach(function (d) {
      var id = d.appId || ('com.webos.app.' + String(d.id || '').toLowerCase().replace(/_/g, ''));
      if (/^com\.webos\.app\.hdmi\d$/.test(id)) out.push({ id: id, title: str(d.label, 40) || String(d.id) });
    });
    if (!out.length) {
      (apps || []).forEach(function (a) { if (/^com\.webos\.app\.hdmi\d$/.test(a.id)) out.push({ id: a.id, title: a.title || a.id }); });
    }
    out.sort(function (x, y) { return x.id < y.id ? -1 : 1; });
    (apps || []).forEach(function (a) { if (a.id === 'com.webos.app.livetv') out.push({ id: a.id, title: a.title || 'Live TV' }); });
    cb(out);
  });
}

// The keys of KEYS this TV's own key filters name.
var tvKeys = null;
function keysOnTv() {
  if (tvKeys) return tvKeys;
  var src = '';
  try {
    fs.readdirSync(KEY_FILTERS).forEach(function (f) {
      if (/\.js$/.test(f)) src += fs.readFileSync(path.join(KEY_FILTERS, f), 'utf8');
    });
  } catch (e) { return []; }
  tvKeys = KEYS.filter(function (k) { return src.indexOf(k.symbol) !== -1; });
  return tvKeys;
}

function keyNames() { return keysOnTv().map(function (k) { return k.key; }); }

// The file an app's icon is in, from listApps only, so no other path is ever read.
function iconFile(apps, id) {
  var a = null;
  (apps || []).forEach(function (x) { if (x.id === id) a = x; });
  if (!a) return null;
  var names = [a.largeIcon, a.icon].filter(function (n) { return typeof n === 'string' && n; });
  for (var i = 0; i < names.length; i++) {
    var n = names[i].charAt(0) === '$' ? names[i].slice(1) : names[i];
    var tries = n.charAt(0) === '/' ? [n] : [path.join(a.folderPath || '', n), path.join(a.folderPath || '', 'hd1080', n)];
    for (var j = 0; j < tries.length; j++) {
      if (/\.(png|jpe?g|webp)$/i.test(tries[j]) && fs.existsSync(tries[j])) return tries[j];
    }
  }
  return null;
}

// The wired or Wi-Fi address before any other (a TV may also have Wi-Fi Direct up).
function lanAddress() {
  var nets = os.networkInterfaces(), found = '';
  var rank = function (n) { return /^eth/.test(n) ? 0 : /^wlan/.test(n) ? 1 : 2; };
  Object.keys(nets).sort(function (a, b) { return rank(a) - rank(b); }).forEach(function (name) {
    (nets[name] || []).forEach(function (a) {
      if (!found && !a.internal && (a.family === 'IPv4' || a.family === 4)) found = a.address;
    });
  });
  return found;
}

/* ---------- the remote key, through GlassHouse ---------- */

function readRemoteKeys() {
  try {
    var j = JSON.parse(fs.readFileSync(REMOTE_KEYS, 'utf8'));
    return j && typeof j === 'object' ? j : {};
  } catch (e) { return {}; }
}

/*
 * Points the chosen key at Lightkeeper, and takes it off any other key, leaving
 * every key GlassHouse set alone. The map file is GlassHouse's, rewritten as it
 * writes it; the configd value is what its filter reads, so a change applies at
 * once where the filter is in the compositor's chain. Where it is not yet (no
 * key ever set in GlassHouse), GlassHouse is restarted, and puts it there a
 * minute later. cb(state): 'off', 'active', 'pending', 'noglasshouse' or 'failed'.
 */
function applyKey(key, cb) {
  if (!fs.existsSync(path.join(TVWEB, 'tvweb.js'))) return cb(key === 'none' ? 'off' : 'noglasshouse');
  var j = readRemoteKeys();
  var keys = j.keys && typeof j.keys === 'object' ? j.keys : {};
  var before = JSON.stringify([keys, j.home || '']);
  Object.keys(keys).forEach(function (k) { if (keys[k] === APP_ID) delete keys[k]; });
  var home = j.home === APP_ID ? '' : (typeof j.home === 'string' ? j.home : '');
  if (key === 'home') home = APP_ID;
  else if (key !== 'none') keys[key] = APP_ID;
  if (JSON.stringify([keys, home]) !== before) {
    var starting = typeof j.starting === 'string' ? j.starting : '';
    try {
      if (!Object.keys(keys).length && !home && !starting) {
        try { fs.unlinkSync(REMOTE_KEYS); } catch (e) {}
      } else {
        var out = { keys: keys, updated: new Date().toISOString() };
        if (home) out.home = home;
        if (starting) out.starting = starting;
        writeAtomic(REMOTE_KEYS, JSON.stringify(out, null, 2) + '\n', 420);
      }
    } catch (e) {
      log('remote keys: ' + e.message);
      return cb('failed');
    }
    var value = { keys: keys };
    if (home) value.home = home;
    if (starting) value.starting = starting;
    var configs = {};
    configs[REMOTE_KEYS_VALUE] = value;
    return luna('com.webos.service.config/setConfigs', { configs: configs }, function () { keyState(key, true, cb); });
  }
  keyState(key, false, cb);
}

function keyState(key, changed, cb) {
  if (key === 'none') return cb('off');
  luna('com.webos.service.config/getConfigs', { configNames: [CHAIN] }, function (r) {
    var list = (r && r.configs && r.configs[CHAIN]) || [];
    var inChain = list.some ? list.some(function (e) { return e && e.file === FILTER_FILE; }) : false;
    if (inChain) return cb('active');
    if (!r) return cb('failed');
    if (changed) execFile(path.join(TVWEB, 'tvwebctl'), ['restart'], { timeout: 30000 }, function () {});
    cb('pending');
  });
}

/* ---------- first start, uninstall ---------- */

// The first start picks the usual apps this TV has, or its first few.
function pickTiles(cb) {
  listApps(function (apps) {
    if (!apps) return cb(null);
    var choices = appChoices(apps), byId = {};
    choices.forEach(function (c) { byId[c.id] = c; });
    var tiles = USUAL_APPS.filter(function (id) { return byId[id]; }).map(function (id) { return byId[id]; });
    cb((tiles.length ? tiles : choices).slice(0, 5));
  });
}

function uninstall(removeApp, cb) {
  applyKey('none', function () {
    try { fs.unlinkSync(HOOK); } catch (e) {}
    try { rmrf(DATA); } catch (e) { log('uninstall: ' + e.message); }
    log('uninstalled');
    if (!removeApp) return cb();
    luna('com.webos.appInstallService/dev/remove', { id: APP_ID }, function () { cb(); });
  });
}

// The app removed from the TV's own menu leaves this running from memory: once
// its files have been gone for a minute (not an update, which puts them back
// within seconds), the key goes back to LG and everything else goes too.
var missing = 0;
function watchApp() {
  if (fs.existsSync(path.join(APP_DIR, 'appinfo.json'))) { missing = 0; return; }
  if (++missing < 3) return;
  log('the app is gone');
  uninstall(false, function () { process.exit(0); });
}

/* ---------- HTTP ---------- */

var TYPES = { '.html': 'text/html; charset=utf-8', '.woff2': 'font/woff2', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.json': 'application/json', '.js': 'text/javascript; charset=utf-8' };

function send(res, status, body, headers) {
  var h = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
  Object.keys(headers || {}).forEach(function (k) { h[k] = headers[k]; });
  if (typeof body === 'object' && !Buffer.isBuffer(body)) {
    body = JSON.stringify(body);
    h['Content-Type'] = 'application/json';
  }
  res.writeHead(status, h);
  res.end(body);
}

function sendFile(res, file, cache, extra) {
  fs.readFile(file, function (err, data) {
    if (err) return send(res, 404, { ok: false, error: 'not found' });
    var h = { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream' };
    if (cache) h['Cache-Control'] = cache;
    Object.keys(extra || {}).forEach(function (k) { h[k] = extra[k]; });
    send(res, 200, data, h);
  });
}

// The TV itself and the private ranges: nothing from beyond the local network.
function isLocal(addr) {
  addr = String(addr || '').replace(/^::ffff:/, '');
  if (net.isIPv4(addr)) {
    var p = addr.split('.').map(Number);
    return p[0] === 10 || p[0] === 127 || (p[0] === 192 && p[1] === 168) ||
      (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 169 && p[1] === 254);
  }
  return addr === '::1' || /^f[cd]/i.test(addr) || /^fe[89ab]/i.test(addr);
}

// An IP literal or localhost only: a name rebound to the TV's address is refused.
function hostOk(req) {
  var h = String(req.headers.host || '').toLowerCase();
  var m = /^\[([^\]]+)\](:\d+)?$/.exec(h);
  if (m) h = m[1];
  else h = h.replace(/:\d+$/, '');
  return !!net.isIP(h) || h === 'localhost';
}

// A write needs this exact type, which a page elsewhere cannot send without a
// preflight that is never approved, and an Origin, when sent, of this host.
function postOk(req, type) {
  if (String(req.headers['content-type'] || '').split(';')[0].toLowerCase() !== type) return false;
  var origin = req.headers.origin;
  return !origin || origin.replace(/^https?:\/\//, '') === req.headers.host;
}

function readBody(req, limit, cb) {
  var chunks = [], size = 0, over = false;
  req.on('data', function (d) {
    size += d.length;
    if (size > limit) { over = true; chunks = []; return; }
    if (!over) chunks.push(d);
  });
  req.on('end', function () { cb(over ? null : Buffer.concat(chunks)); });
}

function readJson(req, res, cb) {
  if (!postOk(req, 'application/json')) return send(res, 415, { ok: false, error: 'bad request' });
  readBody(req, MAX_JSON, function (b) {
    if (!b) return send(res, 413, { ok: false, error: 'too large' });
    var j = null;
    try { j = JSON.parse(b.toString('utf8')); } catch (e) {}
    if (!j || typeof j !== 'object') return send(res, 400, { ok: false, error: 'malformed JSON' });
    cb(j);
  });
}

// The size of a JPEG, from its first frame header, or null if it is not one.
function jpegSize(b) {
  if (b.length < 4 || b[0] !== 0xFF || b[1] !== 0xD8) return null;
  var i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xFF) return null;
    var m = b[i + 1];
    if (m === 0xFF) { i++; continue; }
    if (m === 0x01 || (m >= 0xD0 && m <= 0xD7)) { i += 2; continue; }
    if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) {
      return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
    }
    i += 2 + b.readUInt16BE(i + 2);
  }
  return null;
}

var keyStatus = 'off';

function handle(req, res) {
  if (!isLocal(req.socket.remoteAddress)) return send(res, 403, { ok: false, error: 'local network only' });
  if (!hostOk(req)) return send(res, 403, { ok: false, error: 'use the TV\'s address' });
  var u = String(req.url || '/'), q = u.indexOf('?');
  var p = q === -1 ? u : u.slice(0, q), query = q === -1 ? '' : u.slice(q + 1);
  var m = req.method;

  if (m === 'GET' && (p === '/' || p === '/settings')) {
    return sendFile(res, path.join(HERE, 'settings.html'), 'no-store', {
      'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
        "img-src 'self' data: blob:; connect-src 'self' https://geocoding-api.open-meteo.com https://api.open-meteo.com; frame-ancestors 'none'",
      'X-Frame-Options': 'DENY'
    });
  }
  if (m === 'GET' && p === '/logos.js') return sendFile(res, path.join(APP_DIR, 'logos.js'), 'no-cache');
  if (m === 'GET' && /^\/logos\/[a-z0-9]+\.png$/.test(p)) return sendFile(res, path.join(APP_DIR, p.slice(1)), 'max-age=86400');
  if (m === 'GET' && /^\/jost(-[235]00)?\.woff2$/.test(p)) return sendFile(res, path.join(APP_DIR, p.slice(1)), 'max-age=86400');
  if (m === 'GET' && /^\/backgrounds\/((thumbs\/)?[a-z0-9-]+\.jpg|index\.json)$/.test(p)) {
    // The list changes with an update of the app; the pictures under a name never do.
    return sendFile(res, path.join(APP_DIR, p.slice(1)), /\.json$/.test(p) ? 'no-cache' : 'max-age=86400');
  }
  // The background in use: the picture uploaded, or the one chosen among those the app carries.
  if (m === 'GET' && p === '/background.jpg') {
    var preset = PRESETS.indexOf(config.preset) !== -1 ? config.preset : PRESETS[0];
    return sendFile(res, config.background.custom && fs.existsSync(BACKGROUND) ? BACKGROUND : path.join(APP_DIR, 'backgrounds', preset + '.jpg'), 'max-age=31536000');
  }
  if (m === 'GET' && p === '/icon') {
    var id = decodeURIComponent((/(?:^|&)id=([^&]*)/.exec(query) || [])[1] || '');
    if (!ID_RE.test(id)) return send(res, 400, { ok: false, error: 'bad id' });
    return listApps(function (apps) {
      var f = iconFile(apps, id);
      if (!f) return send(res, 404, { ok: false, error: 'no icon' });
      // As data for a page that turns it white: a canvas may always read a data: picture.
      if (/(?:^|&)data=1(?:&|$)/.test(query)) {
        return fs.readFile(f, function (err, data) {
          if (err) return send(res, 404, { ok: false, error: 'no icon' });
          send(res, 200, { ok: true, src: 'data:' + (TYPES[path.extname(f).toLowerCase()] || 'image/png') + ';base64,' + data.toString('base64') },
            { 'Access-Control-Allow-Origin': '*' });
        });
      }
      sendFile(res, f, 'max-age=86400', { 'Content-Security-Policy': "default-src 'none'" });
    });
  }
  // The Home reads this from its own file:// page, so any origin may read it;
  // it holds nothing secret.
  if (m === 'GET' && p === '/api/config') {
    var c = publicConfig();
    c.keyStatus = keyStatus;
    return send(res, 200, c, { 'Access-Control-Allow-Origin': '*' });
  }

  if (p.indexOf('/api/') !== 0) return send(res, 404, { ok: false, error: 'not found' });
  if (!pinOk(req)) {
    return send(res, 401, { ok: false, error: Date.now() < pinLockedUntil ? 'locked' : 'pin' });
  }

  if (m === 'GET' && p === '/api/tv') {
    return listApps(function (apps) {
      inputChoices(apps, function (inputs) {
        send(res, 200, {
          ok: true, apps: appChoices(apps), inputs: inputs, keyStatus: keyStatus,
          keys: keysOnTv().map(function (k) { return { key: k.key, title: k.title }; }),
          glasshouse: fs.existsSync(path.join(TVWEB, 'tvweb.js'))
        });
      });
    });
  }
  if (m === 'POST' && p === '/api/config') {
    return readJson(req, res, function (body) {
      var change = validate(body, keyNames());
      if (typeof change === 'string') return send(res, 400, { ok: false, error: 'invalid: ' + change });
      Object.keys(change).forEach(function (k) { config[k] = change[k]; });
      // Choosing one of the app's backgrounds puts an uploaded picture away.
      if (has(change, 'preset') && config.background.custom) {
        try { fs.unlinkSync(BACKGROUND); } catch (e) {}
        config.background = { custom: false, rev: (config.background.rev || 0) + 1 };
      }
      try { saveConfig(); } catch (e) { return send(res, 500, { ok: false, error: e.message }); }
      if (!has(change, 'key')) return send(res, 200, { ok: true, config: publicConfig(), keyStatus: keyStatus });
      applyKey(config.key, function (state) {
        keyStatus = state;
        send(res, 200, { ok: true, config: publicConfig(), keyStatus: keyStatus });
      });
    });
  }
  if (m === 'POST' && p === '/api/background') {
    if (!postOk(req, 'image/jpeg')) return send(res, 415, { ok: false, error: 'a JPEG is expected' });
    return readBody(req, MAX_IMAGE, function (b) {
      if (!b) return send(res, 413, { ok: false, error: 'too large' });
      var size = jpegSize(b);
      if (!size || size.width < 640 || size.width > 3840 || size.height > 2160) {
        return send(res, 400, { ok: false, error: 'a JPEG up to 3840 × 2160 is expected' });
      }
      try {
        if (!fs.existsSync(DATA)) fs.mkdirSync(DATA, 448);
        writeAtomic(BACKGROUND, b, 420);
        config.background = { custom: true, rev: (config.background.rev || 0) + 1 };
        saveConfig();
      } catch (e) { return send(res, 500, { ok: false, error: e.message }); }
      send(res, 200, { ok: true, config: publicConfig() });
    });
  }
  if (m === 'DELETE' && p === '/api/background') {
    try { fs.unlinkSync(BACKGROUND); } catch (e) {}
    config.background = { custom: false, rev: (config.background.rev || 0) + 1 };
    saveConfig();
    return send(res, 200, { ok: true, config: publicConfig() });
  }
  if (m === 'POST' && p === '/api/screensaver') {
    return readJson(req, res, function (body) {
      if (typeof body.pause !== 'boolean') return send(res, 400, { ok: false, error: 'pause expected' });
      pauseSaver(body.pause ? 3600000 : 0);
      send(res, 200, { ok: true, config: publicConfig() });
    });
  }
  if (m === 'POST' && p === '/api/pin') {
    return readJson(req, res, function (body) {
      var pin = body.pin;
      if (pin === '') config.pin = null;
      else if (typeof pin === 'string' && /^\d{4,8}$/.test(pin)) {
        var salt = crypto.randomBytes(16).toString('hex');
        config.pin = { salt: salt, hash: pinHash(pin, salt) };
      } else return send(res, 400, { ok: false, error: 'a PIN is 4 to 8 digits' });
      saveConfig();
      send(res, 200, { ok: true, config: publicConfig() });
    });
  }
  if (m === 'POST' && p === '/api/uninstall') {
    return readJson(req, res, function (body) {
      if (body.confirm !== true) return send(res, 400, { ok: false, error: 'confirm expected' });
      send(res, 200, { ok: true });
      setTimeout(function () { uninstall(true, function () { process.exit(0); }); }, 500);
    });
  }
  send(res, 404, { ok: false, error: 'not found' });
}

function start() {
  config = loadConfig();
  var server = http.createServer(function (req, res) {
    try { handle(req, res); } catch (e) {
      log('error: ' + (e && e.stack || e));
      try { send(res, 500, { ok: false, error: 'server error' }); } catch (e2) {}
    }
  });
  server.on('error', function (e) { log('server: ' + e.message); process.exit(1); });
  server.listen(PORT, '0.0.0.0', function () { log('Lightkeeper ' + VERSION + ' on port ' + PORT); });

  // The key is put back as set at each start: GlassHouse may have been
  // reinstalled, or configd reset. Luna can be slow to come up after a boot.
  (function firstRun(tries) {
    var go = function () {
      applyKey(config.key, function (state) {
        keyStatus = state;
        if (state === 'failed' && tries < 10) setTimeout(function () { firstRun(tries + 1); }, 15000);
      });
    };
    if (config.tiles) return go();
    if (tries > 40) return;
    pickTiles(function (tiles) {
      if (!tiles) return setTimeout(function () { firstRun(tries + 1); }, 15000);
      config.tiles = tiles;
      try { saveConfig(); } catch (e) { log('config: ' + e.message); }
      go();
    });
  })(0);
  setInterval(watchApp, 30000);
  // Stopped by the boot hook (an update, a new start): the screen saver watch goes too.
  process.on('SIGTERM', function () { process.exit(0); });
  process.on('exit', function () { if (saverChild) saverChild.kill(); });
}

module.exports = { validate: validate, jpegSize: jpegSize, isLocal: isLocal, hostOk: hostOk,
  applyKey: applyKey, iconFile: iconFile, appChoices: appChoices, keysOnTv: keysOnTv,
  pinHash: pinHash, same: same };

if (require.main === module) {
  if (process.argv[2] === '--uninstall') {
    uninstall(true, function () { process.exit(0); });
  } else {
    start();
  }
}
