/*
 * Lightkeeper's check: the server's validation, its guards and the remote-key
 * map, against the stand-in TV in test/fake-tv. Run with `node test/check.js`.
 */
'use strict';
var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var http = require('http');
var spawn = require('child_process').spawn;

var FAKE = path.join(__dirname, 'fake-tv');
var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lightkeeper-'));
var env = {
  LIGHTKEEPER_DATA: path.join(tmp, 'data'),
  LIGHTKEEPER_TVWEB: path.join(tmp, 'tvweb'),
  LIGHTKEEPER_HOOK: path.join(tmp, 'hook'),
  LIGHTKEEPER_LUNA_SEND: path.join(FAKE, 'luna-send'),
  LIGHTKEEPER_KEY_FILTERS: path.join(FAKE, 'KeyFilters'),
  LIGHTKEEPER_PORT: '18090'
};
fs.mkdirSync(env.LIGHTKEEPER_TVWEB);
fs.writeFileSync(path.join(env.LIGHTKEEPER_TVWEB, 'tvweb.js'), '');
fs.writeFileSync(path.join(env.LIGHTKEEPER_TVWEB, 'tvwebctl'), '#!/bin/sh\n', { mode: 493 });
fs.writeFileSync(env.LIGHTKEEPER_HOOK, '');
Object.keys(env).forEach(function (k) { process.env[k] = env[k]; });
try { fs.unlinkSync(path.join(FAKE, 'calls.log')); } catch (e) {}
try { fs.unlinkSync(path.join(FAKE, 'chain-has-filter')); } catch (e) {}

var s = require('../app/service/server.js');

// Validation: good values pass cleaned, anything else refuses the change.
var keys = ['red', 'netflix'];
assert.deepEqual(s.validate({ clock: '12', veil: 42.4, openAtPowerOn: false }, keys), { clock: '12', veil: 42, openAtPowerOn: false });
assert.deepEqual(s.validate({ tiles: [{ id: 'netflix', title: '  Netflix \n' }] }, keys), { tiles: [{ id: 'netflix', title: 'Netflix' }] });
assert.equal(s.validate({ tiles: [{ id: '../etc', title: 'x' }] }, keys), 'tiles');
assert.equal(s.validate({ tiles: [{ id: 'a', title: 'x' }, { id: 'a', title: 'y' }] }, keys), 'tiles');
assert.equal(s.validate({ veil: 101 }, keys), 'veil');
assert.equal(s.validate({ key: 'power' }, keys), 'key');
assert.deepEqual(s.validate({ key: 'red' }, keys), { key: 'red' });
assert.equal(s.validate({ weather: { name: 'X', lat: 91, lon: 0 } }, keys), 'weather');
assert.equal(s.validate({ pin: '1234' }, keys), 'pin');
assert.equal(s.validate({ language: 'fr' }, keys), 'language');
assert.deepEqual(s.validate({ preset: 'night' }, keys), { preset: 'night' });
assert.deepEqual(s.validate({ tileStyle: 'logo', tiles: [{ id: 'com.webos.app.hdmi3', title: 'PS5', device: 'ps5' }] }, keys),
  { tileStyle: 'logo', tiles: [{ id: 'com.webos.app.hdmi3', title: 'PS5', device: 'ps5' }] });
assert.equal(s.validate({ tiles: [{ id: 'netflix', title: 'Netflix', device: 'ps5' }] }, keys), 'tiles'); // apps have no device
assert.equal(s.validate({ tiles: [{ id: 'com.webos.app.hdmi1', title: 'X', device: 'toaster' }] }, keys), 'tiles');
assert.equal(s.validate({ preset: '../../etc/passwd' }, keys), 'preset');

// The device an HDMI label names (logos.js runs in the page; here only its pure part).
var vm = require('vm'), logos = {};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'app', 'logos.js'), 'utf8'), logos);
[['PS5 Console giochi', 'ps5'], ['PlayStation 4', 'ps4'], ['Xbox Series X', 'xboxseries'], ['XBOX ONE', 'xbox'],
 ['Nintendo Switch 2', 'switch'], ['Steam Deck', 'steamdeck'], ['Apple TV 4K', 'appletv'], ['Shield TV', 'shield'],
 ['Chromecast', 'googletv'], ['Fire TV Stick', 'firetv'], ['Game console', 'console'], ['HDMI 2', 'hdmi'], ['', 'hdmi']
].forEach(function (c) { assert.equal(logos.indovinaApparecchio(c[0]), c[1], c[0]); });
assert.equal(logos.logoDi({ id: 'netflix', title: 'Netflix' }, 'logo'), 'netflix');
assert.equal(logos.logoDi({ id: 'netflix', title: 'Netflix' }, 'icon'), ''); // the TV's own icon
assert.equal(logos.logoDi({ id: 'amazon', title: 'Prime Video' }, 'logo'), ''); // no logo: the TV's icon
assert.equal(logos.logoDi({ id: 'com.webos.app.hdmi3', title: 'PlayStation 5' }, 'icon'), 'playstation5');
assert.equal(logos.logoDi({ id: 'com.webos.app.hdmi1', title: 'Box', device: 'firetv' }, 'logo'), 'box');

// Guards.
assert.ok(s.isLocal('192.168.0.20') && s.isLocal('::ffff:10.1.2.3') && s.isLocal('127.0.0.1') && s.isLocal('fe80::1'));
assert.ok(!s.isLocal('8.8.8.8') && !s.isLocal('172.32.0.1') && !s.isLocal('2001:db8::1'));
assert.ok(s.hostOk({ headers: { host: '192.168.1.50:8090' } }) && s.hostOk({ headers: { host: 'localhost:8090' } }));
assert.ok(!s.hostOk({ headers: { host: 'evil.example:8090' } }) && !s.hostOk({ headers: {} }));

// A JPEG's size from its frame header; anything else is not one.
var jpeg = fs.readFileSync(path.join(__dirname, '..', 'app', 'backgrounds', 'godrevy.jpg'));
assert.deepEqual(s.jpegSize(jpeg), { width: 1920, height: 1080 });
assert.equal(s.jpegSize(fs.readFileSync(path.join(__dirname, '..', 'app', 'icon.png'))), null);

// Keys this TV's filters name.
assert.deepEqual(s.keysOnTv().map(function (k) { return k.key; }), ['netflix', 'amazon', 'info', 'red', 'green', 'yellow', 'blue']);

var mapFile = path.join(env.LIGHTKEEPER_TVWEB, 'remotekeys.json');
fs.writeFileSync(mapFile, JSON.stringify({ keys: { netflix: 'cdp-30' }, starting: '' }));

s.applyKey('home', function (state) {
  // No filter in the chain yet: GlassHouse is restarted to put it there.
  assert.equal(state, 'pending');
  var j = JSON.parse(fs.readFileSync(mapFile, 'utf8'));
  assert.equal(j.home, 'io.github.chiotas.lightkeeper');
  assert.deepEqual(j.keys, { netflix: 'cdp-30' }); // GlassHouse's own key left alone
  fs.writeFileSync(path.join(FAKE, 'chain-has-filter'), '');
  s.applyKey('red', function (state2) {
    assert.equal(state2, 'active');
    var j2 = JSON.parse(fs.readFileSync(mapFile, 'utf8'));
    assert.equal(j2.home, undefined);
    assert.deepEqual(j2.keys, { netflix: 'cdp-30', red: 'io.github.chiotas.lightkeeper' });
    var log = fs.readFileSync(path.join(FAKE, 'calls.log'), 'utf8');
    assert.ok(log.indexOf('"red":"io.github.chiotas.lightkeeper"') !== -1, 'configd written');
    s.applyKey('none', function (state3) {
      assert.equal(state3, 'off');
      assert.deepEqual(JSON.parse(fs.readFileSync(mapFile, 'utf8')).keys, { netflix: 'cdp-30' });
      httpChecks();
    });
  });
});

function req(method, p, opts, cb) {
  opts = opts || {};
  var headers = { Host: opts.host || '127.0.0.1:18090' };
  Object.keys(opts.headers || {}).forEach(function (k) { headers[k] = opts.headers[k]; });
  var r = http.request({ host: '127.0.0.1', port: 18090, method: method, path: p, headers: headers }, function (res) {
    var b = '';
    res.on('data', function (d) { b += d; });
    res.on('end', function () { var j = null; try { j = JSON.parse(b); } catch (e) {} cb(res.statusCode, j, res.headers); });
  });
  if (opts.body) r.write(opts.body);
  r.end();
}

function json(o) { return { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o) }; }

function httpChecks() {
  var child = spawn(process.execPath, [path.join(__dirname, '..', 'app', 'service', 'server.js')], { env: process.env, stdio: 'inherit' });
  var steps = [
    function (next) { req('GET', '/api/config', {}, function (st, j, h) {
      assert.equal(st, 200); assert.equal(h['access-control-allow-origin'], '*');
      assert.equal(j.pin, undefined); assert.equal(j.pinSet, false); next(); }); },
    function (next) { setTimeout(next, 600); }, // the first start picks the tiles
    function (next) { req('GET', '/api/config', {}, function (st, j) {
      assert.deepEqual(j.tiles.map(function (t) { return t.id; }), ['netflix', 'amazon', 'youtube.leanback.v4', 'cdp-30', 'spotify-beehive']); next(); }); },
    function (next) { req('GET', '/api/config', { host: 'evil.example:18090' }, function (st) { assert.equal(st, 403); next(); }); },
    function (next) { req('POST', '/api/config', { headers: { 'Content-Type': 'text/plain' }, body: '{"clock":"12"}' }, function (st) { assert.equal(st, 415); next(); }); },
    function (next) { var o = json({ clock: '12' }); o.headers.Origin = 'http://evil.example'; req('POST', '/api/config', o, function (st) { assert.equal(st, 415); next(); }); },
    function (next) { req('POST', '/api/config', json({ clock: '12', veil: 60 }), function (st, j) { assert.equal(st, 200); assert.equal(j.config.clock, '12'); next(); }); },
    function (next) { req('POST', '/api/config', json({ run: 'rm -rf /' }), function (st, j) { assert.equal(st, 400); assert.equal(j.error, 'invalid: run'); next(); }); },
    function (next) { req('GET', '/api/tv', {}, function (st, j) {
      assert.equal(st, 200);
      assert.deepEqual(j.inputs.map(function (i) { return i.title; }), ['HDMI 1', 'HDMI 2', 'Game console', 'Live TV']);
      assert.ok(j.apps.every(function (a) { return a.id !== 'io.github.chiotas.lightkeeper' && !/hdmi/.test(a.id); })); next(); }); },
    function (next) { req('GET', '/icon?id=netflix', {}, function (st, j, h) { assert.equal(st, 200); assert.equal(h['content-type'], 'image/png'); next(); }); },
    function (next) { req('GET', '/icon?id=..%2F..%2Fetc', {}, function (st) { assert.equal(st, 400); next(); }); },
    function (next) { req('GET', '/backgrounds/index.json', {}, function (st, j) { assert.equal(st, 200); assert.equal(j[0].id, 'godrevy'); next(); }); },
    function (next) { req('GET', '/backgrounds/..%2Fappinfo.json', {}, function (st) { assert.equal(st, 404); next(); }); },
    function (next) { req('GET', '/backgrounds/thumbs/night.jpg', {}, function (st, j, h) { assert.equal(st, 200); assert.equal(h['content-type'], 'image/jpeg'); next(); }); },
    function (next) { req('POST', '/api/background', { headers: { 'Content-Type': 'image/jpeg' }, body: 'GIF89a not a jpeg' }, function (st) { assert.equal(st, 400); next(); }); },
    function (next) { req('POST', '/api/background', { headers: { 'Content-Type': 'image/jpeg' }, body: jpeg }, function (st, j) {
      assert.equal(st, 200); assert.equal(j.config.background.custom, true); next(); }); },
    // Choosing one of the app's backgrounds puts the uploaded picture away.
    function (next) { req('POST', '/api/config', json({ preset: 'night' }), function (st, j) {
      assert.equal(st, 200); assert.equal(j.config.preset, 'night'); assert.equal(j.config.background.custom, false);
      assert.ok(!fs.existsSync(path.join(env.LIGHTKEEPER_DATA, 'background.jpg'))); next(); }); },
    function (next) { req('POST', '/api/pin', json({ pin: '12' }), function (st) { assert.equal(st, 400); next(); }); },
    function (next) { req('POST', '/api/pin', json({ pin: '2468' }), function (st) { assert.equal(st, 200); next(); }); },
    function (next) { req('GET', '/api/tv', {}, function (st) { assert.equal(st, 401); next(); }); },
    function (next) { req('GET', '/api/tv', { headers: { 'X-Lightkeeper-Pin': '2468' } }, function (st) { assert.equal(st, 200); next(); }); },
    function (next) {
      var n = 0;
      (function wrong() {
        req('GET', '/api/tv', { headers: { 'X-Lightkeeper-Pin': '0000' } }, function (st, j) {
          if (++n < 5) return wrong();
          req('GET', '/api/tv', { headers: { 'X-Lightkeeper-Pin': '2468' } }, function (st2, j2) {
            assert.equal(st2, 401); assert.equal(j2.error, 'locked'); next(); // even the right PIN waits a minute
          });
        });
      })();
    },
    function (next) {
      var saved = JSON.parse(fs.readFileSync(path.join(env.LIGHTKEEPER_DATA, 'config.json'), 'utf8'));
      assert.ok(/^[0-9a-f]{64}$/.test(saved.pin.hash) && JSON.stringify(saved).indexOf('2468') === -1, 'the PIN is kept hashed');
      next();
    }
  ];
  function run(i) {
    if (i === steps.length) {
      child.kill();
      console.log('check: all good');
      return;
    }
    steps[i](function () { run(i + 1); });
  }
  child.on('exit', function (code) { if (code) { console.error('server exited ' + code); process.exit(1); } });
  setTimeout(function () { run(0); }, 700); // a moment to start listening
}
