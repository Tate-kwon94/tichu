/* 심(shim) — 실체는 shared/exchange-infer.js. load(path) API 유지(측정 도구용). */
'use strict';
var path = require('path');
var fs = require('fs');
var INF = require(path.join(__dirname, '..', 'shared', 'exchange-infer.js'));
function load(wPath) { return INF.create(JSON.parse(fs.readFileSync(wPath, 'utf8'))); }
module.exports = { load: load, create: INF.create };
