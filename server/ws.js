/* RFC 6455 WebSocket 서버 — 직접 구현, 의존성 0
 * 핸드셰이크 / 프레임 파싱(마스킹·분할) / ping-pong / close / 백프레셔 컷 */
'use strict';
var crypto = require('crypto');

var GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
var MAX_PAYLOAD = 1024 * 1024;       // 1MB
var MAX_BUFFERED = 256 * 1024;       // 송신 버퍼 초과 시 연결 종료
var PING_INTERVAL = 25000;

function WSConn(socket, head) {
  this.socket = socket;
  this.buf = head && head.length ? Buffer.from(head) : Buffer.alloc(0);
  this.frag = null;          // {op, chunks}
  this.closed = false;
  this.closeSent = false;
  this.missedPongs = 0;
  this.onmessage = null;
  this.onclose = null;

  var self = this;
  socket.on('data', function (d) {
    self.buf = self.buf.length ? Buffer.concat([self.buf, d]) : d;
    try { self._parse(); } catch (e) { self.destroy(); }
  });
  socket.on('error', function () { self.destroy(); }); // ECONNRESET 등 — 프로세스 보호
  socket.on('close', function () { self._finish(); });

  this.pingTimer = setInterval(function () {
    if (self.closed) return;
    self.missedPongs++;
    if (self.missedPongs > 2) { self.destroy(); return; }
    self._raw(0x9, Buffer.alloc(0));
  }, PING_INTERVAL);

  // head에 이미 도착한 프레임이 있을 수 있음
  if (this.buf.length) {
    setImmediate(function () { try { self._parse(); } catch (e) { self.destroy(); } });
  }
}

WSConn.prototype._parse = function () {
  for (;;) {
    var buf = this.buf;
    if (buf.length < 2) return;
    var b0 = buf[0], b1 = buf[1];
    var fin = (b0 & 0x80) !== 0;
    var op = b0 & 0x0f;
    var masked = (b1 & 0x80) !== 0;
    var len = b1 & 0x7f;
    var off = 2;
    if (len === 126) {
      if (buf.length < 4) return;
      len = buf.readUInt16BE(2);
      off = 4;
    } else if (len === 127) {
      if (buf.length < 10) return;
      var hi = buf.readUInt32BE(2), lo = buf.readUInt32BE(6);
      len = hi * 4294967296 + lo;
      off = 10;
    }
    if (len > MAX_PAYLOAD) { this.close(1009); return; }
    if (!masked) { this.close(1002); return; } // 클라이언트 프레임은 마스킹 필수
    if (buf.length < off + 4 + len) return;
    var key = buf.slice(off, off + 4);
    var payload = Buffer.allocUnsafe(len);
    buf.copy(payload, 0, off + 4, off + 4 + len);
    for (var i = 0; i < len; i++) payload[i] ^= key[i & 3];
    this.buf = buf.slice(off + 4 + len);
    this._dispatch(op, fin, payload);
    if (this.closed) return;
  }
};

WSConn.prototype._dispatch = function (op, fin, payload) {
  switch (op) {
    case 0x1: // 텍스트
    case 0x2: // 바이너리(미지원이지만 분할 조립은 동일)
      if (this.frag) { this.close(1002); return; }
      if (payload.length > MAX_PAYLOAD) { this.close(1009); return; }
      if (fin) this._deliver(op, payload);
      else this.frag = { op: op, chunks: [payload], len: payload.length };
      break;
    case 0x0: // 연속
      if (!this.frag) { this.close(1002); return; }
      this.frag.len += payload.length;
      // 누적 바이트를 프레임마다 검사 — fin을 안 보내고 무한 분할로 메모리를 키우는 공격 차단
      if (this.frag.len > MAX_PAYLOAD || this.frag.chunks.length > 4096) { this.frag = null; this.close(1009); return; }
      this.frag.chunks.push(payload);
      if (fin) {
        var whole = Buffer.concat(this.frag.chunks);
        var fop = this.frag.op;
        this.frag = null;
        this._deliver(fop, whole);
      }
      break;
    case 0x8: // close
      this.close(1000);
      break;
    case 0x9: // ping → pong (payload 에코)
      this._raw(0xA, payload.slice(0, 125));
      break;
    case 0xA: // pong
      this.missedPongs = 0;
      break;
    default:
      this.close(1002);
  }
};

WSConn.prototype._deliver = function (op, payload) {
  if (op === 0x2) { this.close(1003); return; } // 바이너리 미사용
  this.missedPongs = 0;
  if (this.onmessage) {
    var s;
    try { s = payload.toString('utf8'); } catch (e) { this.close(1007); return; }
    this.onmessage(s);
  }
};

WSConn.prototype._raw = function (opcode, payload) {
  if (this.closed || this.socket.destroyed) return;
  if (this.socket.writableLength > MAX_BUFFERED) { this.destroy(); return; } // 백프레셔
  var len = payload.length, header;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeUInt32BE(Math.floor(len / 4294967296), 2);
    header.writeUInt32BE(len >>> 0, 6);
  }
  try { this.socket.write(Buffer.concat([header, payload])); } catch (e) { this.destroy(); }
};

WSConn.prototype.send = function (obj) {
  var s = typeof obj === 'string' ? obj : JSON.stringify(obj);
  this._raw(0x1, Buffer.from(s, 'utf8'));
};

WSConn.prototype.close = function (code) {
  if (!this.closeSent) {
    this.closeSent = true;
    var p = Buffer.alloc(2);
    p.writeUInt16BE(code || 1000, 0);
    this._raw(0x8, p);
  }
  var self = this;
  setTimeout(function () { self.destroy(); }, 300);
};

WSConn.prototype.destroy = function () {
  if (this.closed) return;
  this.closed = true;
  try { this.socket.destroy(); } catch (e) { /* 무시 */ }
  this._finish();
};

WSConn.prototype._finish = function () {
  clearInterval(this.pingTimer);
  if (this.closed) return this._fireClose();
  this.closed = true;
  this._fireClose();
};
WSConn.prototype._fireClose = function () {
  if (this.onclose) { var cb = this.onclose; this.onclose = null; cb(); }
};

// HTTP 서버에 업그레이드 핸들러 부착
function attach(server, pathName, onConnection) {
  server.on('upgrade', function (req, socket, head) {
    try {
      var url = (req.url || '').split('?')[0];
      var upgrade = String(req.headers.upgrade || '').toLowerCase();
      var connection = String(req.headers.connection || '').toLowerCase();
      var key = req.headers['sec-websocket-key'];
      var ver = req.headers['sec-websocket-version'];
      if (url !== pathName || upgrade !== 'websocket' || connection.indexOf('upgrade') < 0 || !key || ver !== '13') {
        socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      var accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
      // permessage-deflate 등 확장은 절대 에코하지 않음 (미구현 확장 수락 금지)
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
      );
      socket.setNoDelay(true);
      socket.setTimeout(0);
      var conn = new WSConn(socket, head);
      onConnection(conn, req);
    } catch (e) {
      try { socket.destroy(); } catch (e2) { /* 무시 */ }
    }
  });
}

module.exports = { attach: attach };
