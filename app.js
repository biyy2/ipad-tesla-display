/* ParkDesk display. iPad draws the picture, Tesla shows it.
   Signaling: PeerJS 1.5.4 + 0.peerjs.com.
   Media path: LAN P2P only. iceServers is public STUN, never TURN. */

(function () {
  "use strict";

  var BROKER = { host: "0.peerjs.com", port: 443, path: "/", secure: true };
  var ICE_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }];
  var RESOLUTIONS = [
    { id: "1920", w: 1920, h: 1200, label: "1920×1200" },
    { id: "2560", w: 2560, h: 1600, label: "2560×1600" },
    { id: "1280", w: 1280, h: 800, label: "1280×800" }
  ];
  var CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  var CHUNK_BYTES = 3500;

  ICE_SERVERS.forEach(function (server) {
    var urls = [].concat(server.urls || []);
    urls.forEach(function (url) {
      if (/^turns?:/i.test(String(url))) throw new Error("TURN은 사용하지 않습니다");
    });
  });

  var role = (new URLSearchParams(location.search).get("role") || "").toLowerCase();
  if (role === "sender") role = "ipad";

  var results = {
    v: 2,
    app: "parkdesk-display",
    role: role || "home",
    startedAt: nowIso(),
    pageUrl: location.href,
    iceServers: ICE_SERVERS.map(function (s) { return s.urls; }),
    icePolicy: "all",
    turn: false,
    broker: { host: BROKER.host, library: "peerjs@1.5.4" },
    env: {},
    support: {},
    codecs: {},
    iceTimeline: [],
    iceSelected: null,
    media: null,
    logs: [],
    errors: []
  };

  var senderPeer = null;
  var teslaPeer = null;
  var dataConn = null;
  var mediaCall = null;
  var remoteId = null;
  var senderCode = "";
  var canvasStream = null;
  var displayStream = null;
  var receivedTesla = null;
  var incoming = null;
  var liveStatsSent = false;
  var reconnectTimer = null;
  var reconnectWait = 500;
  var teslaTarget = "";
  var source = "pattern";
  var resolution = RESOLUTIONS[0];
  var frame = 0;
  var strokes = [];
  var activeStroke = null;
  var notesText = "";
  var photo = null;
  var rafId = 0;
  var wakeLock = null;
  var lastStatsSample = null;

  function nowIso() { return new Date().toISOString(); }
  function $(id) { return document.getElementById(id); }
  function pad(n) { return (n < 10 ? "0" : "") + n; }

  function log(id, msg, level) {
    var line = "[" + new Date().toLocaleTimeString("ko-KR", { hour12: false }) + "] " + msg;
    results.logs.push(line);
    if (results.logs.length > 200) results.logs.shift();
    if (level === "error") results.errors.push(msg);
    var el = $(id);
    if (el) {
      el.textContent += line + "\n";
      el.scrollTop = el.scrollHeight;
    }
    console.log(line);
  }

  function setStatus(id, text, kind) {
    var el = $(id);
    if (!el) return;
    el.textContent = text;
    el.className = "status-row" + (kind ? " " + kind : "");
  }

  function kv(dl, rows) {
    if (!dl) return;
    dl.innerHTML = "";
    rows.forEach(function (row) {
      var dt = document.createElement("dt");
      var dd = document.createElement("dd");
      dt.textContent = row[0];
      dd.textContent = row[1];
      if (row[2]) dd.className = row[2];
      dl.appendChild(dt);
      dl.appendChild(dd);
    });
  }

  function classifyIp(addr) {
    if (!addr) return "";
    if (String(addr).endsWith(".local")) return "mDNS";
    var m = String(addr).match(/^(\d+)\.(\d+)\./);
    if (!m) return "";
    var a = +m[1];
    var b = +m[2];
    if (a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31)) return "사설";
    if (a === 127) return "loopback";
    return "공인";
  }

  function readEnv() {
    results.env = {
      userAgent: navigator.userAgent,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      screenWidth: screen.width,
      screenHeight: screen.height,
      devicePixelRatio: window.devicePixelRatio || 1,
      secureContext: window.isSecureContext
    };
    return results.env;
  }

  function readSupport() {
    results.support = {
      RTCPeerConnection: typeof RTCPeerConnection === "function",
      RTCDataChannel: "RTCDataChannel" in window,
      captureStream: !!(document.createElement("canvas").captureStream),
      getDisplayMedia: !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia),
      wakeLock: !!(navigator.wakeLock && navigator.wakeLock.request),
      PeerJS: typeof window.Peer === "function"
    };
    var codecs = { h264: false };
    try {
      if (window.RTCRtpReceiver && RTCRtpReceiver.getCapabilities) {
        var caps = RTCRtpReceiver.getCapabilities("video") || { codecs: [] };
        (caps.codecs || []).forEach(function (c) {
          if (c && /h264/i.test(c.mimeType || "")) codecs.h264 = true;
        });
      }
    } catch (e) {}
    results.codecs = codecs;
    return results.support;
  }

  function randomCode() {
    var bytes = new Uint8Array(6);
    crypto.getRandomValues(bytes);
    var s = "";
    for (var i = 0; i < 6; i++) s += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
    return s;
  }

  function peerIdFromCode(code) {
    return "parkdesk-" + String(code || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  }

  function rtcConfig() {
    return { iceServers: ICE_SERVERS.map(function (s) { return { urls: s.urls }; }), sdpSemantics: "unified-plan" };
  }

  function peerOptions(id) {
    var opts = {
      host: BROKER.host,
      port: BROKER.port,
      path: BROKER.path,
      secure: true,
      debug: 0,
      config: rtcConfig()
    };
    return id ? new Peer(id, opts) : new Peer(opts);
  }

  function snapshot() {
    results.finishedAt = nowIso();
    results.role = role || results.role;
    results.resolution = resolution ? { w: resolution.w, h: resolution.h } : null;
    results.source = source;
    return JSON.stringify(results, null, 2);
  }

  function utf8Size(s) {
    return window.TextEncoder ? new TextEncoder().encode(s).length : s.length;
  }

  function chunkUtf8(str, maxBytes) {
    var chunks = [];
    var i = 0;
    while (i < str.length) {
      var end = Math.min(str.length, i + maxBytes);
      while (end > i + 1 && utf8Size(str.slice(i, end)) > maxBytes) {
        end = i + Math.max(1, Math.floor((end - i) / 2));
      }
      chunks.push(str.slice(i, end));
      i = end;
    }
    return chunks.length ? chunks : [""];
  }

  function sendResults(reason) {
    if (!dataConn || !dataConn.open) return false;
    var json = snapshot();
    var parts = chunkUtf8(json, CHUNK_BYTES);
    var id = "r" + Date.now().toString(36);
    for (var i = 0; i < parts.length; i++) {
      dataConn.send({ t: "results", id: id, i: i, n: parts.length, reason: reason || "manual", chunk: parts[i] });
    }
    log("tesla-log", "결과를 보내는 쪽으로 전송했습니다. " + parts.length + "조각 (" + (reason || "manual") + ")");
    return true;
  }

  function ingestChunk(msg) {
    if (!msg || typeof msg.chunk !== "string") return;
    var n = msg.n | 0;
    var i = msg.i | 0;
    if (n < 1 || n > 200 || i < 0 || i >= n) return;
    if (!incoming || incoming.id !== msg.id) incoming = { id: msg.id, n: n, parts: new Array(n), got: 0, reason: msg.reason };
    if (incoming.parts[i] == null) {
      incoming.parts[i] = msg.chunk;
      incoming.got++;
    }
    if (incoming.got < incoming.n) return;
    var json = incoming.parts.join("");
    var reason = incoming.reason;
    incoming = null;
    try { receivedTesla = JSON.parse(json); }
    catch (err) {
      log(role === "pc" ? "pc-log" : "sender-log", "테슬라 결과 파싱 실패: " + err, "error");
      return;
    }
    var hint = $("sender-tesla-hint");
    if (hint) hint.textContent = "수신함 · " + (reason || "") + " · " + json.length + "자";
    var ice = receivedTesla.iceSelected || {};
    kv($("sender-tesla-list"), [
      ["역할", receivedTesla.role || "-"],
      ["화면", ((receivedTesla.env || {}).screenWidth || "?") + "×" + ((receivedTesla.env || {}).screenHeight || "?")],
      ["선택 쌍", ice.pairType || "아직 없음"],
      ["미디어", receivedTesla.media ? "있음" : "없음"],
      ["오류", (receivedTesla.errors || []).length ? receivedTesla.errors.join(" | ") : "없음"]
    ]);
    log(role === "pc" ? "pc-log" : "sender-log", "테슬라 결과 수신 (" + (reason || "") + ")");
  }

  function combinedText() {
    var senderObj;
    try { senderObj = JSON.parse(snapshot()); } catch (e) { senderObj = { error: String(e) }; }
    return JSON.stringify({ sender: senderObj, tesla: receivedTesla }, null, 2);
  }

  async function copyText(text, boxId, logId) {
    var box = $(boxId);
    if (box) box.value = text;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        log(logId, "클립보드에 복사했습니다.");
        return;
      }
    } catch (err) {
      log(logId, "클립보드 복사 실패. 아래 글을 길게 눌러 복사하세요.");
    }
    if (box) { box.focus(); box.select(); }
  }

  function downloadText(text, boxId, logId) {
    var box = $(boxId);
    if (box) box.value = text;
    var blob = new Blob([text], { type: "application/json" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = "parkdesk-display-" + new Date().toISOString().replace(/[:.]/g, "-") + ".json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
    log(logId, "JSON 파일을 저장했습니다.");
  }

  function pushIce(entry) {
    entry.at = nowIso();
    results.iceTimeline.push(entry);
    if (results.iceTimeline.length > 80) results.iceTimeline.shift();
  }

  function watchPc(pc, logId, label) {
    if (!pc || pc.__watched) return;
    pc.__watched = true;
    var seen = {};
    function note(kind, extra) {
      var row = { kind: kind, label: label || "" };
      if (extra) Object.keys(extra).forEach(function (k) { row[k] = extra[k]; });
      pushIce(row);
      var text = "ICE " + (label ? label + " " : "") + kind;
      if (extra && extra.state) text += " " + extra.state;
      if (extra && extra.candidate) text += " " + extra.candidate;
      log(logId, text);
    }
    note("watch", { state: pc.iceConnectionState });
    pc.addEventListener("iceconnectionstatechange", function () {
      note("iceConnectionState", { state: pc.iceConnectionState });
      if (pc.iceConnectionState === "connected" || pc.iceConnectionState === "completed" || pc.iceConnectionState === "failed") {
        readSelected(pc, logId, label, 0);
      }
      if (pc.iceConnectionState === "failed" && role === "tesla") showPhoto("ICE failed");
    });
    pc.addEventListener("connectionstatechange", function () {
      note("connectionState", { state: pc.connectionState });
    });
    pc.addEventListener("icecandidate", function (ev) {
      if (!ev.candidate || !ev.candidate.candidate) return;
      var raw = ev.candidate.candidate;
      var typ = (raw.match(/ typ ([^ ]+)/) || [])[1] || "?";
      var proto = (raw.match(/ (udp|tcp) /i) || [])[1] || "";
      var addr = ev.candidate.address || "";
      var key = typ + proto + addr + ev.candidate.port;
      if (seen[key]) return;
      seen[key] = true;
      note("local-candidate", { candidate: typ + " " + proto + " " + (addr || "주소 숨김") + (classifyIp(addr) ? " " + classifyIp(addr) : "") });
    });
  }

  function watchConn(conn, logId, label) {
    var tries = 0;
    (function tick() {
      var pc = conn && (conn.peerConnection || conn._pc);
      if (pc) { watchPc(pc, logId, label); return; }
      if (tries++ < 30) setTimeout(tick, 100);
    })();
  }

  async function readSelected(pc, logId, label, attempt) {
    var report;
    try { report = await pc.getStats(); } catch (e) { return; }
    var pair = null;
    var locals = {};
    var remotes = {};
    report.forEach(function (s) {
      if (s.type === "local-candidate") locals[s.id] = s;
      if (s.type === "remote-candidate") remotes[s.id] = s;
      if (s.type === "transport" && s.selectedCandidatePairId) pair = report.get(s.selectedCandidatePairId) || pair;
      if (s.type === "candidate-pair" && (s.nominated || s.selected || s.state === "succeeded")) {
        if (!pair || s.nominated || s.selected) pair = s;
      }
    });
    var local = pair ? locals[pair.localCandidateId] : null;
    var remote = pair ? remotes[pair.remoteCandidateId] : null;
    if ((!local && !remote) && attempt < 3) {
      setTimeout(function () { readSelected(pc, logId, label, attempt + 1); }, 500);
      return;
    }
    function side(c) {
      if (!c) return null;
      var typ = c.candidateType || "";
      var addr = c.address || c.ip || "";
      return { typ: typ, protocol: c.protocol || "", address: addr, range: classifyIp(addr) };
    }
    var localInfo = side(local);
    var remoteInfo = side(remote);
    var pairType = "unknown";
    var lt = localInfo && localInfo.typ;
    var rt = remoteInfo && remoteInfo.typ;
    if (lt === "relay" || rt === "relay") pairType = "relay";
    else if (lt === "srflx" || rt === "srflx" || lt === "prflx" || rt === "prflx") pairType = "srflx";
    else if (lt && lt.indexOf("host") === 0 && rt && rt.indexOf("host") === 0) pairType = "host";
    results.iceSelected = { at: nowIso(), label: label, pairType: pairType, local: localInfo, remote: remoteInfo, state: pair && pair.state };
    log(logId, "선택 쌍 " + pairType + " local=" + (lt || "?") + " remote=" + (rt || "?"));
    if (role === "tesla" && dataConn && dataConn.open && !liveStatsSent && pair) {
      liveStatsSent = true;
      sendResults("stats-ready");
    }
  }

  async function sampleMedia(pc, video) {
    if (!pc || !pc.getStats) return null;
    var report = await pc.getStats();
    var inbound = null;
    var outbound = null;
    report.forEach(function (s) {
      if (s.type === "inbound-rtp" && s.kind === "video") inbound = s;
      if (s.type === "outbound-rtp" && s.kind === "video") outbound = s;
    });
    var stat = inbound || outbound;
    var now = performance.now();
    var bytes = stat ? (stat.bytesReceived != null ? stat.bytesReceived : stat.bytesSent) : null;
    var bitrate = null;
    if (stat && lastStatsSample && bytes != null && lastStatsSample.bytes != null) {
      var dt = (now - lastStatsSample.ts) / 1000;
      if (dt > 0) bitrate = Math.round((bytes - lastStatsSample.bytes) * 8 / dt);
    }
    if (stat) lastStatsSample = { ts: now, bytes: bytes };
    var info = {
      width: (video && video.videoWidth) || (stat && stat.frameWidth) || 0,
      height: (video && video.videoHeight) || (stat && stat.frameHeight) || 0,
      fps: stat && stat.framesPerSecond != null ? stat.framesPerSecond : null,
      bitrate: bitrate,
      framesDecoded: stat && (stat.framesDecoded || 0),
      framesSent: stat && (stat.framesSent || 0),
      framesReceived: stat && (stat.framesReceived || 0),
      pairType: results.iceSelected && results.iceSelected.pairType,
      local: results.iceSelected && results.iceSelected.local,
      remote: results.iceSelected && results.iceSelected.remote
    };
    results.media = info;
    return info;
  }

  function formatPair(info) {
    if (!info || !info.pairType) return "-";
    var local = info.local ? info.local.typ : "?";
    var remote = info.remote ? info.remote.typ : "?";
    var kind = info.pairType;
    var label = kind === "host" ? "host (같은 LAN 직접)" : kind === "srflx" ? "srflx (STUN)" : kind === "relay" ? "relay" : kind;
    return label + " · local " + local + " / remote " + remote;
  }

  function showPhoto(reason) {
    var card = $("tesla-photo");
    var body = $("tesla-photo-body");
    if (!card || !body) return;
    var env = results.env || {};
    var last = "";
    (results.iceTimeline || []).forEach(function (ev) {
      if (ev.kind === "iceConnectionState") last = ev.state;
    });
    var lines = [
      ["실패", reason || "-"],
      ["화면", (env.screenWidth || "?") + "×" + (env.screenHeight || "?") + " dpr " + (env.devicePixelRatio || "?")],
      ["WebRTC", results.support.RTCPeerConnection ? "지원" : "없음"],
      ["H.264", results.codecs && results.codecs.h264 ? "있음" : "없음"],
      ["ICE", (results.iceSelected && results.iceSelected.pairType) || "선택 없음"],
      ["상태", last || "-"],
      ["STUN만", "TURN 없음"]
    ];
    body.innerHTML = "";
    lines.forEach(function (row) {
      var p = document.createElement("p");
      p.className = "photo-line";
      var k = document.createElement("span");
      k.className = "photo-k";
      k.textContent = row[0];
      var v = document.createElement("span");
      v.className = "photo-v";
      v.textContent = row[1];
      p.appendChild(k);
      p.appendChild(v);
      body.appendChild(p);
    });
    card.classList.remove("hidden");
  }

  function hidePhoto() {
    var card = $("tesla-photo");
    if (card) card.classList.add("hidden");
  }

  function scheduleReconnect(which) {
    if (reconnectTimer) return;
    var wait = reconnectWait;
    reconnectWait = Math.min(8000, wait * 2);
    reconnectTimer = setTimeout(function () {
      reconnectTimer = null;
      var peer = which === "tesla" ? teslaPeer : senderPeer;
      var logId = which === "tesla" ? "tesla-log" : (role === "pc" ? "pc-log" : "sender-log");
      if (!peer || peer.destroyed) return;
      if (!peer.disconnected) { reconnectWait = 500; return; }
      log(logId, "브로커에 같은 ID로 다시 연결합니다.");
      try { peer.reconnect(); }
      catch (err) { log(logId, "재연결 실패: " + err, "error"); scheduleReconnect(which); }
    }, wait);
  }

  function bindBroker(peer, which) {
    var logId = which === "tesla" ? "tesla-log" : (role === "pc" ? "pc-log" : "sender-log");
    var statusId = which === "tesla" ? "tesla-status" : (role === "pc" ? "pc-status" : "sender-status");
    peer.on("disconnected", function () {
      log(logId, "브로커와 끊겼습니다. 코드는 유지합니다.");
      scheduleReconnect(which);
    });
    peer.on("error", function (err) {
      var typ = (err && err.type) || "";
      if (typ === "network" || typ === "socket-error" || typ === "socket-closed" || typ === "server-error" || typ === "disconnected") {
        log(logId, "브로커 오류 (" + typ + "). 같은 코드로 재연결합니다.");
        scheduleReconnect(which);
        return;
      }
      if (typ === "unavailable-id" && which !== "tesla") {
        var next = randomCode();
        log(logId, "코드가 사용 중입니다. 새 코드 " + next);
        startSender(next);
        return;
      }
      log(logId, "Peer 오류: " + typ + " " + err, "error");
      if (which === "tesla" && typ !== "peer-unavailable") {
        setStatus(statusId, "연결 실패: " + typ, "bad");
        if (typ === "webrtc" || typ === "negotiation-failed") showPhoto(typ);
      } else if (typ !== "peer-unavailable") {
        setStatus(statusId, "오류: " + typ, "bad");
      }
    });
  }

  function requestWake() {
    if (!navigator.wakeLock || document.hidden) return;
    navigator.wakeLock.request("screen").then(function (lock) {
      wakeLock = lock;
    }).catch(function () {});
  }

  function drawWrapped(ctx, text, x, y, maxW, lineH) {
    String(text || "").split(/\n/).forEach(function (para) {
      var line = "";
      for (var i = 0; i < para.length; i++) {
        var test = line + para[i];
        if (ctx.measureText(test).width > maxW && line) {
          ctx.fillText(line, x, y);
          y += lineH;
          line = para[i];
        } else line = test;
      }
      ctx.fillText(line, x, y);
      y += lineH;
    });
  }

  function drawFrame() {
    var canvas = $("stage-canvas");
    if (!canvas) return;
    var ctx = canvas.getContext("2d");
    var w = canvas.width;
    var h = canvas.height;
    if (source === "pattern") {
      ctx.fillStyle = "#10141b";
      ctx.fillRect(0, 0, w, h);
      var bars = 24;
      var bw = Math.ceil(w / bars);
      for (var i = 0; i < bars; i++) {
        ctx.fillStyle = "hsl(" + ((i * 18 + frame) % 360) + " 68% 48%)";
        var x = ((i * bw + frame * 6) % (w + bw)) - bw;
        ctx.fillRect(x, 0, bw * 0.72, h);
      }
      ctx.fillStyle = "#ffffff";
      ctx.fillRect((frame * 10) % w, 0, 8, h);
      ctx.fillStyle = "rgba(0,0,0,.5)";
      ctx.fillRect(0, h * 0.3, w, h * 0.4);
      ctx.fillStyle = "#fff";
      ctx.textAlign = "center";
      ctx.font = "700 " + Math.floor(h * 0.14) + "px sans-serif";
      var now = new Date();
      ctx.fillText(pad(now.getHours()) + ":" + pad(now.getMinutes()) + ":" + pad(now.getSeconds()), w / 2, h * 0.48);
      ctx.font = "600 " + Math.floor(h * 0.055) + "px sans-serif";
      ctx.fillText("프레임 " + frame + "   " + w + "×" + h, w / 2, h * 0.6);
    } else if (source === "board") {
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, w, h);
      ctx.strokeStyle = "#16181d";
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      strokes.forEach(function (stroke) {
        if (!stroke.points.length) return;
        ctx.beginPath();
        ctx.lineWidth = stroke.width;
        ctx.moveTo(stroke.points[0].x, stroke.points[0].y);
        for (var p = 1; p < stroke.points.length; p++) ctx.lineTo(stroke.points[p].x, stroke.points[p].y);
        ctx.stroke();
      });
    } else if (source === "notes") {
      ctx.fillStyle = "#f6f3ea";
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = "#1b1b1b";
      ctx.textAlign = "left";
      var fontSize = Math.floor(h * 0.07);
      ctx.font = "700 " + fontSize + "px sans-serif";
      drawWrapped(ctx, notesText || "메모를 입력하세요", w * 0.08, h * 0.16, w * 0.84, fontSize * 1.28);
    } else {
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, w, h);
      if (photo && photo.width) {
        var scale = Math.min(w / photo.width, h / photo.height);
        var dw = photo.width * scale;
        var dh = photo.height * scale;
        ctx.drawImage(photo, (w - dw) / 2, (h - dh) / 2, dw, dh);
      } else {
        ctx.fillStyle = "#d5d8e0";
        ctx.textAlign = "center";
        ctx.font = "600 " + Math.floor(h * 0.06) + "px sans-serif";
        ctx.fillText("사진을 선택하세요", w / 2, h / 2);
      }
    }
  }

  function canvasPoint(ev) {
    var canvas = $("stage-canvas");
    var rect = canvas.getBoundingClientRect();
    return {
      x: (ev.clientX - rect.left) * (canvas.width / Math.max(1, rect.width)),
      y: (ev.clientY - rect.top) * (canvas.height / Math.max(1, rect.height))
    };
  }

  function bindCanvas() {
    var canvas = $("stage-canvas");
    canvas.width = resolution.w;
    canvas.height = resolution.h;
    drawFrame();
    canvas.addEventListener("pointerdown", function (ev) {
      if (source !== "board") return;
      ev.preventDefault();
      try { canvas.setPointerCapture(ev.pointerId); } catch (e) {}
      var pt = canvasPoint(ev);
      var width = ev.pointerType === "pen" ? 4 : 7;
      if (ev.pressure && ev.pressure > 0 && ev.pressure < 1) width = 3 + ev.pressure * 12;
      activeStroke = { width: width, points: [pt] };
      strokes.push(activeStroke);
    });
    canvas.addEventListener("pointermove", function (ev) {
      if (!activeStroke || source !== "board") return;
      ev.preventDefault();
      activeStroke.points.push(canvasPoint(ev));
    });
    function endStroke() { activeStroke = null; }
    canvas.addEventListener("pointerup", endStroke);
    canvas.addEventListener("pointercancel", endStroke);
    if (canvas.captureStream) {
      try { canvasStream = canvas.captureStream(30); }
      catch (err) { log("sender-log", "captureStream 실패: " + err, "error"); }
    } else {
      log("sender-log", "이 브라우저는 canvas.captureStream을 지원하지 않습니다.", "error");
    }
  }

  function loop() {
    if (role === "ipad" && !document.hidden) {
      frame += 1;
      drawFrame();
      if (canvasStream) {
        canvasStream.getVideoTracks().forEach(function (track) {
          if (typeof track.requestFrame === "function") track.requestFrame();
        });
      }
    }
    rafId = requestAnimationFrame(loop);
  }

  function setSource(next) {
    source = next;
    var buttons = document.querySelectorAll("[data-source]");
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].classList.toggle("is-on", buttons[i].getAttribute("data-source") === next);
    }
    $("board-tools").classList.toggle("hidden", next !== "board");
    $("image-tools").classList.toggle("hidden", next !== "image");
    $("notes-label").classList.toggle("hidden", next !== "notes");
    $("notes-input").classList.toggle("hidden", next !== "notes");
    drawFrame();
  }

  function setResolution(id) {
    resolution = RESOLUTIONS.filter(function (r) { return r.id === id; })[0] || RESOLUTIONS[0];
    var canvas = $("stage-canvas");
    if (canvas) {
      canvas.width = resolution.w;
      canvas.height = resolution.h;
    }
    var buttons = document.querySelectorAll("[data-res]");
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].classList.toggle("is-on", buttons[i].getAttribute("data-res") === resolution.id);
    }
    drawFrame();
    log("sender-log", "해상도 " + resolution.label);
  }

  function ensureSendStream() {
    var canvas = $("stage-canvas");
    if (canvasStream && canvasStream.getVideoTracks().some(function (t) { return t.readyState === "live"; })) return canvasStream;
    if (!canvas || !canvas.captureStream) return null;
    canvasStream = canvas.captureStream(30);
    return canvasStream;
  }

  function placeCall(stream) {
    var logId = role === "pc" ? "pc-log" : "sender-log";
    if (!senderPeer || !remoteId || !stream) return;
    try { if (mediaCall) mediaCall.close(); } catch (e) {}
    mediaCall = senderPeer.call(remoteId, stream);
    if (!mediaCall) {
      log(logId, "화면 호출에 실패했습니다.", "error");
      return;
    }
    watchConn(mediaCall, logId, "media");
    mediaCall.on("error", function (err) { log(logId, "미디어 오류: " + err, "error"); });
    var tracks = stream.getVideoTracks().map(function (t) { return t.readyState + (t.muted ? "/muted" : ""); });
    log(logId, "테슬라로 화면을 보냅니다. 비디오 트랙 " + (tracks.join(",") || "없음"));
    setTimeout(function () {
      var pc = mediaCall && mediaCall.peerConnection;
      if (!pc || !pc.getSenders) return;
      var rtp = pc.getSenders().filter(function (s) { return s.track && s.track.kind === "video"; })[0];
      if (!rtp || !rtp.getParameters || !rtp.setParameters) return;
      try {
        var params = rtp.getParameters();
        params.degradationPreference = "maintain-resolution";
        if (!params.encodings || !params.encodings.length) params.encodings = [{}];
        params.encodings[0].scaleResolutionDownBy = 1;
        params.encodings[0].maxBitrate = 2500000;
        rtp.setParameters(params).catch(function () {});
      } catch (e) {}
    }, 400);
  }

  function renderSenderStats(info) {
    kv($("sender-stats"), [
      ["내용", source],
      ["캔버스", resolution.w + "×" + resolution.h],
      ["프레임", String(frame)],
      ["선택 쌍", formatPair(info || results.iceSelected)],
      ["송신 fps", info && info.fps != null ? String(info.fps) : "-"],
      ["비트레이트", info && info.bitrate != null ? Math.round(info.bitrate / 1000) + " kbps" : "-"]
    ]);
  }

  function startSender(code) {
    var logId = role === "pc" ? "pc-log" : "sender-log";
    var statusId = role === "pc" ? "pc-status" : "sender-status";
    var codeId = role === "pc" ? "pc-code" : "sender-code";
    if (senderPeer) {
      try { senderPeer.destroy(); } catch (e) {}
      senderPeer = null;
    }
    dataConn = null;
    mediaCall = null;
    remoteId = null;
    receivedTesla = null;
    senderCode = code;
    $(codeId).textContent = code;
    setStatus(statusId, "브로커 연결 중…", "wait");
    log(logId, "코드 " + code + " 로 등록합니다. STUN만 사용합니다.");
    var peer = peerOptions(peerIdFromCode(code));
    senderPeer = peer;
    bindBroker(peer, "sender");
    peer.on("open", function (openId) {
      reconnectWait = 500;
      setStatus(statusId, "코드 대기 중 — 테슬라에서 입력하세요", "wait");
      log(logId, "브로커 등록 완료 " + openId);
    });
    peer.on("connection", function (conn) {
      dataConn = conn;
      remoteId = conn.peer;
      log(logId, "테슬라 연결 수신 " + conn.peer);
      watchConn(conn, logId, "data");
      conn.on("open", function () {
        setStatus(statusId, "테슬라와 연결됨", "ok");
        log(logId, "DataChannel이 열렸습니다.");
        if (role === "ipad") placeCall(ensureSendStream());
        else if (displayStream) placeCall(displayStream);
      });
      conn.on("data", function (data) {
        if (data && data.t === "results") ingestChunk(data);
        if (data && data.t === "ping" && dataConn && dataConn.open) {
          dataConn.send({ t: "pong", n: data.n, t0: data.t0 });
        }
      });
      conn.on("close", function () {
        log(logId, "DataChannel이 닫혔습니다.");
        setStatus(statusId, "테슬라 연결이 끊겼습니다", "bad");
      });
    });
  }

  function renderOverlay(info) {
    var box = $("tesla-overlay");
    if (!box) return;
    var fps = info && info.fps != null ? info.fps : "-";
    var kbps = info && info.bitrate != null ? Math.round(info.bitrate / 1000) + " kbps" : "-";
    var res = info ? (info.width + "×" + info.height) : "-";
    var lines = [
      "해상도 " + res,
      "fps " + fps + "   비트레이트 " + kbps,
      "경로 " + formatPair(info || results.iceSelected),
      "RTT " + (results.rttMs != null ? results.rttMs + " ms" : "-"),
      "받은 프레임 " + (info && info.framesDecoded != null ? info.framesDecoded : "-")
    ];
    box.innerHTML = "";
    lines.forEach(function (line) {
      var p = document.createElement("p");
      p.textContent = line;
      box.appendChild(p);
    });
  }

  function goFullscreen() {
    var video = $("tesla-video");
    var play = video.play();
    if (play && play.catch) play.catch(function () {});
    if (video.webkitEnterFullscreen) {
      try { video.webkitEnterFullscreen(); return; } catch (e) {}
    }
    var target = video.requestFullscreen ? video : document.documentElement;
    if (target.requestFullscreen) target.requestFullscreen().catch(function () {});
  }

  var videoAttached = false;
  function attachStream(stream) {
    if (!stream || videoAttached) return;
    var tracks = stream.getVideoTracks ? stream.getVideoTracks() : [];
    if (!tracks.length) return;
    videoAttached = true;
    var video = $("tesla-video");
    video.srcObject = stream;
    video.muted = true;
    video.playsInline = true;
    video.setAttribute("playsinline", "");
    $("tesla-video-empty").classList.add("hidden");
    var play = video.play();
    if (play && play.catch) play.catch(function () {
      log("tesla-log", "자동 재생이 막혔습니다. 전체 화면을 누르세요.");
    });
    log("tesla-log", "화면 스트림을 받았습니다. 트랙 " + tracks.length);
  }

  function pullRemoteVideo(call) {
    var tries = 0;
    (function tick() {
      if (videoAttached) return;
      var pc = call && call.peerConnection;
      if (pc && pc.getReceivers) {
        var tracks = pc.getReceivers().map(function (r) { return r.track; }).filter(function (t) {
          return t && t.kind === "video" && t.readyState !== "ended";
        });
        if (tries === 4 || tries === 20) {
          log("tesla-log", "수신 트랙 " + pc.getReceivers().length + "개, 비디오 " + tracks.length + "개");
        }
        if (tracks.length) {
          attachStream(new MediaStream(tracks));
          return;
        }
      }
      if (tries++ < 40) setTimeout(tick, 250);
    })();
  }

  function wireTesla(conn) {
    dataConn = conn;
    watchConn(conn, "tesla-log", "data");
    conn.on("data", function (data) {
      if (data && data.t === "pong" && data.t0) results.rttMs = Math.round(performance.now() - data.t0);
    });
    conn.on("open", function () {
      log("tesla-log", "DataChannel이 열렸습니다.");
      setStatus("tesla-status", "아이패드와 연결됨", "ok");
      hidePhoto();
      var btn = $("btn-send-results");
      if (btn) btn.disabled = false;
      sendResults("channel-open");
      if (results._ping) clearInterval(results._ping);
      var n = 0;
      results._ping = setInterval(function () {
        if (!dataConn || !dataConn.open || n++ > 60) {
          if (results._ping && n > 60) clearInterval(results._ping);
          return;
        }
        try { dataConn.send({ t: "ping", n: n, t0: performance.now() }); } catch (e) {}
      }, 1000);
    });
    conn.on("close", function () {
      log("tesla-log", "DataChannel이 닫혔습니다.");
      setStatus("tesla-status", "연결이 끊겼습니다", "bad");
      var btn = $("btn-send-results");
      if (btn) btn.disabled = true;
    });
  }

  function joinTesla(code) {
    code = String(code || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (code.length < 4) {
      log("tesla-log", "코드가 너무 짧습니다.", "error");
      return;
    }
    if (typeof Peer !== "function") {
      log("tesla-log", "PeerJS가 로드되지 않았습니다.", "error");
      return;
    }
    if (teslaPeer) {
      try { teslaPeer.destroy(); } catch (e) {}
      teslaPeer = null;
    }
    liveStatsSent = false;
    videoAttached = false;
    hidePhoto();
    teslaTarget = peerIdFromCode(code);
    results.pairing = { code: code, target: teslaTarget };
    setStatus("tesla-status", "브로커 연결 중…", "wait");
    log("tesla-log", teslaTarget + " 에 연결합니다. STUN만 사용합니다.");
    var peer = peerOptions();
    teslaPeer = peer;
    bindBroker(peer, "tesla");
    peer.on("open", function (id) {
      reconnectWait = 500;
      log("tesla-log", "브로커 연결됨. 내 ID=" + id);
      setStatus("tesla-status", "아이패드를 찾는 중…", "wait");
      wireTesla(peer.connect(teslaTarget, { reliable: true, metadata: { role: "tesla" } }));
    });
    peer.on("call", function (call) {
      mediaCall = call;
      videoAttached = false;
      log("tesla-log", "화면 호출을 받았습니다.");
      call.answer();
      watchConn(call, "tesla-log", "media");
      call.on("stream", attachStream);
      pullRemoteVideo(call);
      call.on("error", function (err) { log("tesla-log", "미디어 오류: " + err, "error"); });
    });
  }

  function leaveTesla() {
    try { if (dataConn) dataConn.close(); } catch (e) {}
    try { if (mediaCall) mediaCall.close(); } catch (e) {}
    try { if (teslaPeer) teslaPeer.destroy(); } catch (e) {}
    dataConn = mediaCall = teslaPeer = null;
    var video = $("tesla-video");
    if (video) video.srcObject = null;
    var empty = $("tesla-video-empty");
    if (empty) empty.classList.remove("hidden");
    var btn = $("btn-send-results");
    if (btn) btn.disabled = true;
    setStatus("tesla-status", "연결을 끊었습니다", "wait");
  }

  async function refreshTeslaOverlay() {
    var pc = (mediaCall && mediaCall.peerConnection) || (dataConn && dataConn.peerConnection);
    var info = pc ? await sampleMedia(pc, $("tesla-video")) : null;
    renderOverlay(info);
  }

  function show(id) {
    ["view-home", "view-ipad", "view-tesla", "view-pc"].forEach(function (view) {
      var el = $(view);
      if (el) el.classList.toggle("hidden", view !== id);
    });
  }

  readEnv();
  readSupport();
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) requestWake();
  });
  document.addEventListener("pointerdown", requestWake, { once: true });

  if (role === "ipad") {
    document.body.classList.add("role-ipad");
    $("page-title").textContent = "iPad 보내기";
    show("view-ipad");
    var row = $("res-row");
    RESOLUTIONS.forEach(function (item) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn mode-btn" + (item.id === resolution.id ? " is-on" : "");
      btn.setAttribute("data-res", item.id);
      btn.textContent = item.label;
      btn.addEventListener("click", function () { setResolution(item.id); });
      row.appendChild(btn);
    });
    var sources = document.querySelectorAll("[data-source]");
    for (var s = 0; s < sources.length; s++) {
      sources[s].addEventListener("click", function () { setSource(this.getAttribute("data-source")); });
    }
    $("btn-clear-board").addEventListener("click", function () { strokes = []; activeStroke = null; drawFrame(); });
    $("notes-input").addEventListener("input", function () { notesText = this.value; drawFrame(); });
    $("image-file").addEventListener("change", function () {
      var file = this.files && this.files[0];
      if (!file) return;
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () { photo = img; setSource("image"); URL.revokeObjectURL(url); };
      img.src = url;
    });
    $("btn-new-code").addEventListener("click", function () { startSender(randomCode()); });
    $("btn-copy-sender").addEventListener("click", function () { copyText(combinedText(), "sender-json", "sender-log"); });
    $("btn-download-sender").addEventListener("click", function () { downloadText(combinedText(), "sender-json", "sender-log"); });
    bindCanvas();
    setSource("pattern");
    requestAnimationFrame(loop);
    startSender(randomCode());
    setInterval(function () {
      var pc = mediaCall && mediaCall.peerConnection;
      if (!pc) { renderSenderStats(null); return; }
      sampleMedia(pc, null).then(renderSenderStats).catch(function () {});
    }, 1000);
    requestWake();
  } else if (role === "tesla") {
    document.body.classList.add("role-tesla");
    $("page-title").textContent = "테슬라 받기";
    show("view-tesla");
    var preset = new URLSearchParams(location.search).get("code");
    if (preset) $("join-code").value = preset.toUpperCase();
    $("btn-join").addEventListener("click", function () { joinTesla($("join-code").value); });
    $("join-code").addEventListener("keydown", function (ev) { if (ev.key === "Enter") joinTesla($("join-code").value); });
    $("btn-leave").addEventListener("click", leaveTesla);
    $("btn-fullscreen").addEventListener("click", goFullscreen);
    $("tesla-video").addEventListener("click", goFullscreen);
    $("btn-overlay").addEventListener("click", function () { $("tesla-overlay").classList.toggle("hidden"); });
    $("btn-send-results").addEventListener("click", function () { sendResults("button"); });
    $("btn-copy-tesla").addEventListener("click", function () { copyText(snapshot(), "tesla-json", "tesla-log"); });
    setInterval(function () { refreshTeslaOverlay().catch(function () {}); }, 1000);
    renderOverlay(null);
    requestWake();
  } else if (role === "pc") {
    document.body.classList.add("role-pc");
    $("page-title").textContent = "노트북 화면 공유";
    show("view-pc");
    $("btn-pc-new-code").addEventListener("click", function () { startSender(randomCode()); });
    $("btn-share").addEventListener("click", async function () {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
        log("pc-log", "이 브라우저는 화면 공유를 지원하지 않습니다.", "error");
        return;
      }
      try {
        displayStream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: false });
      } catch (err) {
        log("pc-log", "화면 공유가 취소되었습니다: " + err, "error");
        return;
      }
      if (remoteId) placeCall(displayStream);
      else log("pc-log", "테슬라가 코드를 입력하면 공유가 시작됩니다. 공유 트랙은 준비됐습니다.");
    });
    $("btn-stop-share").addEventListener("click", function () {
      if (displayStream) displayStream.getTracks().forEach(function (t) { t.stop(); });
      displayStream = null;
      try { if (mediaCall) mediaCall.close(); } catch (e) {}
      log("pc-log", "화면 공유를 중지했습니다.");
    });
    $("btn-copy-pc").addEventListener("click", function () { copyText(combinedText(), "pc-json", "pc-log"); });
    $("btn-download-pc").addEventListener("click", function () { downloadText(combinedText(), "pc-json", "pc-log"); });
    startSender(randomCode());
  } else {
    show("view-home");
  }

  window.addEventListener("error", function (ev) {
    results.errors.push(ev.message);
    console.error(ev.message);
  });
})();
