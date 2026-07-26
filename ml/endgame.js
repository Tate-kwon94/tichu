/* 심(shim) — 실체는 shared/endgame.js (서버·클라이언트 공용 UMD).
 * 기존 ml/ 경로 의존(eval-endgame, eval-hybrid)을 깨지 않기 위해 유지. */
'use strict';
module.exports = require('../shared/endgame.js');
