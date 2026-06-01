(function () {
  var CONFIG = window.CALLMOM_CONFIG || {};
  var PEER_PREFIX = "call-mom-server-relay-v1";
  var POLL_INTERVAL_MS = 250;
  var HELLO_INTERVAL_MS = 3000;
  var TARGET_SAMPLE_RATE = 12000;
  var CHUNK_MS = 250;
  var CHUNK_SAMPLES = Math.floor(TARGET_SAMPLE_RATE * CHUNK_MS / 1000);
  var JITTER_SECONDS = 0.45;
  var MAX_PLAYBACK_LAG_SECONDS = 2.2;
  var MAX_AUDIO_IN_FLIGHT = 2;
  var params = readParams();
  var SIGNAL_URL = CONFIG.signalingUrl || "./signal.php";
  var AudioContextClass = window.AudioContext || window.webkitAudioContext;

  var state = {
    me: null,
    other: null,
    key: "",
    roomHash: "",
    confirmed: false,
    lifted: false,
    connected: false,
    sessionId: "",
    remoteSession: "",
    remoteHelloAt: 0,
    signalAfter: 0,
    localStream: null,
    audioContext: null,
    inputSource: null,
    captureNode: null,
    muteGain: null,
    captureSamples: [],
    pollTimer: null,
    helloTimer: null,
    playbackAt: 0,
    playbackSources: [],
    audioSeq: 0,
    lastRemoteAudioSeq: 0,
    audioInFlight: 0,
    audioTxBytes: 0,
    audioRxBytes: 0,
    audioTxChunks: 0,
    audioRxChunks: 0,
    audioDropped: 0,
    textReady: false
  };

  var elements = {
    lamp: document.getElementById("lamp"),
    statusText: document.getElementById("statusText"),
    roleText: document.getElementById("roleText"),
    setupDialog: document.getElementById("setupDialog"),
    setupForm: document.getElementById("setupForm"),
    setupSubmit: document.getElementById("setupSubmit"),
    secretKey: document.getElementById("secretKey"),
    personButtons: Array.prototype.slice.call(document.querySelectorAll("[data-person]")),
    callButton: document.getElementById("callButton"),
    hint: document.getElementById("hint"),
    remoteAudio: document.getElementById("remoteAudio"),
    chatLog: document.getElementById("chatLog"),
    chatForm: document.getElementById("chatForm"),
    chatInput: document.getElementById("chatInput"),
    chatSend: document.getElementById("chatSend"),
    copyLogButton: document.getElementById("copyLogButton"),
    debugInfo: document.getElementById("debugInfo")
  };

  var debug = {
    peerId: "",
    peerOpen: false,
    peerError: "",
    server: "нет",
    signaling: "нет",
    mic: "нет",
    localAudio: "нет",
    remoteAudio: "нет",
    audioPlay: "нет",
    call: "нет",
    chat: "нет"
  };

  document.documentElement.setAttribute("data-peer-loaded", AudioContextClass ? "server-relay" : "false");

  init();

  function init() {
    var storedPerson = localStorage.getItem("callMomPerson") || "";

    elements.secretKey.value = params.key || "";
    choosePerson(params.me || storedPerson);
    openSetup("Проверьте абонента и код связи.");

    elements.secretKey.addEventListener("input", refreshSetupState);
    elements.setupForm.addEventListener("submit", function (event) {
      event.preventDefault();
      confirmSetup();
    });

    elements.personButtons.forEach(function (button) {
      button.addEventListener("click", function () {
        choosePerson(button.getAttribute("data-person"));
        refreshSetupState();
      });
    });

    elements.callButton.addEventListener("click", function () {
      if (state.lifted) {
        endCall("Трубка положена. Для новой сессии проверьте абонента и код связи.");
        return;
      }

      startCall();
    });

    elements.chatForm.addEventListener("submit", function (event) {
      event.preventDefault();
      sendChatMessage();
    });

    elements.copyLogButton.addEventListener("click", copyDebugLog);

    window.addEventListener("beforeunload", function () {
      if (state.lifted) {
        sendEnvelope("bye", { session: state.sessionId }, "all");
      }
      cleanup();
    });

    refreshSetupState();
    updateDebug();
  }

  function readParams() {
    var text = "";
    if (window.location.search && window.location.search.length > 1) {
      text = window.location.search.slice(1);
    }
    if (window.location.hash && window.location.hash.length > 1) {
      text += (text ? "&" : "") + window.location.hash.slice(1);
    }

    return text.split("&").reduce(function (params, part) {
      var pair = part.split("=");
      if (pair[0]) {
        params[decodeURIComponent(pair[0])] = decodeURIComponent(pair.slice(1).join("=") || "");
      }
      return params;
    }, {});
  }

  function choosePerson(person) {
    if (person !== "1" && person !== "2") {
      state.me = null;
      state.other = null;
    } else {
      state.me = person;
      state.other = person === "1" ? "2" : "1";
    }

    elements.personButtons.forEach(function (button) {
      button.classList.toggle("active", button.getAttribute("data-person") === state.me);
    });

    elements.roleText.textContent = state.me ? "Вы: абонент " + state.me : "Выберите абонента";
  }

  function refreshSetupState() {
    state.key = elements.secretKey.value.trim();

    var ready = Boolean(state.me && state.key);
    elements.setupSubmit.disabled = !ready;
    elements.callButton.disabled = !(state.confirmed && ready && !state.lifted);
    updateDebug();

    if (!ready) {
      setStatus("idle", "Нужны абонент и код связи");
      elements.hint.textContent = "Один код связи должен быть одинаковым на двух устройствах.";
    } else if (!state.confirmed) {
      setStatus("idle", "Проверьте настройки");
      elements.hint.textContent = "Подтвердите абонента и код связи перед звонком.";
    } else if (!state.lifted) {
      setStatus("idle", "Готово");
      elements.hint.textContent = "Нажмите трубку. Второй абонент делает то же самое.";
    }
  }

  function confirmSetup() {
    if (!state.me || !state.key) {
      refreshSetupState();
      return;
    }

    localStorage.setItem("callMomPerson", state.me);
    state.roomHash = hashString(state.key);
    state.confirmed = true;
    closeSetup();
    refreshSetupState();
    updateDebug();
  }

  function openSetup(message) {
    state.confirmed = false;
    elements.setupDialog.hidden = false;
    elements.callButton.disabled = true;
    resetChat();
    refreshSetupState();
    elements.hint.textContent = message;

    setTimeout(function () {
      elements.secretKey.focus();
      elements.secretKey.select();
    }, 0);
  }

  function closeSetup() {
    elements.setupDialog.hidden = true;
  }

  function startCall() {
    if (!AudioContextClass) {
      failCall("Web Audio не поддерживается", "Нужен браузер с Web Audio и доступом к микрофону.");
      return;
    }

    state.lifted = true;
    state.connected = false;
    state.sessionId = createSessionId();
    state.remoteSession = "";
    state.remoteHelloAt = 0;
    state.signalAfter = 0;
    state.captureSamples = [];
    state.playbackAt = 0;
    state.playbackSources = [];
    state.audioSeq = 0;
    state.lastRemoteAudioSeq = 0;
    state.audioInFlight = 0;
    state.audioTxBytes = 0;
    state.audioRxBytes = 0;
    state.audioTxChunks = 0;
    state.audioRxChunks = 0;
    state.audioDropped = 0;
    state.textReady = false;
    debug.peerId = buildPeerId(state.me);
    debug.peerOpen = false;
    debug.peerError = "";
    debug.server = "подключаем";
    debug.signaling = "подключаем";
    debug.mic = "запрашиваем";
    debug.localAudio = "нет";
    debug.remoteAudio = "нет";
    debug.audioPlay = "нет";
    debug.call = "серверное реле";
    debug.chat = "нет";

    resetChat();
    updateDebug();
    setButtonLifted(true);
    closeSetup();
    setStatus("waiting", "Запрашиваем микрофон");
    elements.hint.textContent = "Разрешите микрофон. Связь будет идти через сервер, с задержкой.";

    ensureAudioContext();

    getAudioStream()
      .then(function (stream) {
        state.localStream = stream;
        debug.mic = "разрешен";
        debug.localAudio = describeTracks(stream.getAudioTracks());
        updateDebug();
        startCapture(stream);
        startRelay();
      })
      .catch(function (error) {
        console.error(error);
        debug.mic = "ошибка";
        debug.peerError = error.message || String(error);
        updateDebug();
        failCall("Нет доступа к микрофону", "Разрешите микрофон в браузере и попробуйте снова.");
      });
  }

  function getAudioStream() {
    var constraints = {
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      },
      video: false
    };

    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
      return navigator.mediaDevices.getUserMedia(constraints);
    }

    var oldGetUserMedia =
      navigator.getUserMedia ||
      navigator.webkitGetUserMedia ||
      navigator.mozGetUserMedia;

    if (!oldGetUserMedia) {
      return Promise.reject(new Error("getUserMedia is not supported"));
    }

    return new Promise(function (resolve, reject) {
      oldGetUserMedia.call(navigator, constraints, resolve, reject);
    });
  }

  function ensureAudioContext() {
    if (!state.audioContext) {
      state.audioContext = new AudioContextClass();
    }

    if (state.audioContext.resume) {
      state.audioContext.resume().catch(function () {});
    }

    return state.audioContext;
  }

  function startCapture(stream) {
    var context = ensureAudioContext();
    var processorSize = 4096;

    if (!context.createScriptProcessor || !context.createMediaStreamSource) {
      failCall("Захват звука не поддерживается", "В этом браузере нет нужного Web Audio API.");
      return;
    }

    state.inputSource = context.createMediaStreamSource(stream);
    state.captureNode = context.createScriptProcessor(processorSize, 1, 1);
    state.muteGain = context.createGain();
    state.muteGain.gain.value = 0;

    state.captureNode.onaudioprocess = function (event) {
      if (!state.lifted) {
        return;
      }
      handleInputSamples(event.inputBuffer.getChannelData(0), context.sampleRate);
    };

    state.inputSource.connect(state.captureNode);
    state.captureNode.connect(state.muteGain);
    state.muteGain.connect(context.destination);
  }

  function handleInputSamples(input, inputRate) {
    var samples = downsample(input, inputRate, TARGET_SAMPLE_RATE);
    var i;

    for (i = 0; i < samples.length; i += 1) {
      state.captureSamples.push(samples[i]);
    }

    while (state.captureSamples.length >= CHUNK_SAMPLES) {
      sendAudioChunk(state.captureSamples.splice(0, CHUNK_SAMPLES));
    }
  }

  function downsample(input, inputRate, outputRate) {
    var ratio;
    var length;
    var output;
    var i;

    if (inputRate === outputRate) {
      output = new Float32Array(input.length);
      output.set(input);
      return output;
    }

    ratio = inputRate / outputRate;
    length = Math.max(1, Math.floor(input.length / ratio));
    output = new Float32Array(length);

    for (i = 0; i < length; i += 1) {
      output[i] = input[Math.min(input.length - 1, Math.floor(i * ratio))];
    }

    return output;
  }

  function startRelay() {
    setStatus("waiting", "Синхронизируемся");
    elements.hint.textContent = "Пропускаем старую очередь сервера и начинаем новую сессию.";

    syncToNow()
      .then(function () {
        return sendHello();
      })
      .catch(function (error) {
        debug.peerError = error.message || String(error);
        updateDebug();
      })
      .then(function () {
        pollRelay();
        scheduleHello();
        setStatus("waiting", "Ждем второго абонента");
        elements.hint.textContent = "Текст будет работать через сервер. Голос идет кусками, возможна задержка.";
      });
  }

  function syncToNow() {
    var fallbackQuery = {
      op: "pull",
      room: state.roomHash,
      me: state.me,
      after: 2147483647,
      t: String(Date.now())
    };

    debug.signaling = "sync";
    updateDebug();

    return requestJson("GET", SIGNAL_URL + "?" + encodeQuery(fallbackQuery))
      .then(function (response) {
        state.signalAfter = response.lastId || 0;
        debug.signaling = "ok";
        debug.server = "ok";
        updateDebug();
      });
  }

  function scheduleHello() {
    clearTimeout(state.helloTimer);
    if (!state.lifted) {
      return;
    }

    state.helloTimer = setTimeout(function () {
      if (state.lifted) {
        sendHello();
        scheduleHello();
      }
    }, HELLO_INTERVAL_MS);
  }

  function sendHello() {
    return sendEnvelope("hello", {
      session: state.sessionId,
      sampleRate: TARGET_SAMPLE_RATE
    }, "all");
  }

  function pollRelay() {
    clearTimeout(state.pollTimer);

    if (!state.lifted) {
      return;
    }

    pullMessages()
      .then(function (messages) {
        debug.peerOpen = true;
        debug.signaling = "ok";
        debug.server = "ok";
        debug.peerError = "";
        if (!state.textReady) {
          state.textReady = true;
          debug.chat = "открыт";
          enableChat(true);
          addChatLine("system", "текстовая связь через сервер");
        }
        updateDebug();
        handleMessages(messages || []);
      })
      .catch(function (error) {
        debug.peerOpen = false;
        debug.server = "ошибка";
        debug.signaling = "ошибка";
        debug.peerError = error.message || String(error);
        debug.chat = "нет";
        enableChat(false);
        updateDebug();
        setStatus("waiting", "Нет связи с сервером");
        elements.hint.textContent = "signal.php не отвечает. Проверьте файл на сервере.";
      })
      .then(function () {
        if (state.lifted) {
          state.pollTimer = setTimeout(pollRelay, POLL_INTERVAL_MS);
        }
      });
  }

  function pullMessages() {
    var query = {
      op: "pull",
      room: state.roomHash,
      me: state.me,
      after: state.signalAfter,
      t: String(Date.now())
    };

    return requestJson("GET", SIGNAL_URL + "?" + encodeQuery(query)).then(function (response) {
      if (response.lastId && response.lastId > state.signalAfter) {
        state.signalAfter = response.lastId;
      }
      return response.messages || [];
    });
  }

  function sendEnvelope(type, payload, to) {
    if (!state.roomHash || !state.me) {
      return Promise.resolve();
    }

    return requestJson("POST", SIGNAL_URL + "?op=push", {
      room: state.roomHash,
      from: state.me,
      to: to || state.other,
      type: type,
      session: state.sessionId,
      payload: payload || {}
    }).then(function (response) {
      debug.peerOpen = true;
      debug.signaling = "ok";
      debug.server = "ok";
      updateDebug();
      return response;
    }).catch(function (error) {
      debug.peerOpen = false;
      debug.server = "ошибка";
      debug.signaling = "ошибка";
      debug.peerError = error.message || String(error);
      updateDebug();
      throw error;
    });
  }

  function handleMessages(messages) {
    var i;
    var message;
    var newestHello = null;

    for (i = 0; i < messages.length; i += 1) {
      message = messages[i];
      if (!isRemoteMessage(message)) {
        continue;
      }

      if (message.type === "hello" && (!newestHello || message.createdAt > newestHello.createdAt)) {
        newestHello = message;
      }
    }

    if (newestHello) {
      acceptRemoteHello(newestHello);
    }

    for (i = 0; i < messages.length; i += 1) {
      message = messages[i];
      if (!isRemoteMessage(message)) {
        continue;
      }

      if (message.type === "hello") {
        continue;
      }

      if (message.type === "bye") {
        addChatLine("system", "второй абонент положил трубку");
        continue;
      }

      if (message.type === "text") {
        acceptRemoteSessionFromMessage(message);
        receiveTextMessage(message.payload || {});
      } else if (message.type === "audio") {
        if (!acceptRemoteSessionFromMessage(message)) {
          continue;
        }
        receiveAudioChunk(message.payload || {});
      }
    }
  }

  function isRemoteMessage(message) {
    if (!message || message.from === state.me) {
      return false;
    }

    if (message.to && message.to !== state.me && message.to !== "all") {
      return false;
    }

    return true;
  }

  function acceptRemoteHello(message) {
    if (message.session && message.session !== state.remoteSession) {
      state.remoteSession = message.session;
      state.remoteHelloAt = message.createdAt || Date.now();
      state.lastRemoteAudioSeq = 0;
      state.playbackAt = 0;
      stopScheduledAudio();
      debug.remoteAudio = "ждем аудио";
    }

    if (!state.connected) {
      state.connected = true;
      setStatus("live", "На линии через сервер");
      elements.hint.textContent = "Можно говорить. Задержка нормальна для серверного режима.";
      addChatLine("system", "второй абонент на линии");
    }

    debug.call = "серверное реле";
    updateDebug();
  }

  function acceptRemoteSessionFromMessage(message) {
    if (!message.session) {
      return false;
    }

    if (!state.remoteSession) {
      state.remoteSession = message.session;
      state.remoteHelloAt = message.createdAt || Date.now();
      state.lastRemoteAudioSeq = 0;
      state.playbackAt = 0;
      stopScheduledAudio();
    }

    return message.session === state.remoteSession;
  }

  function sendAudioChunk(samples) {
    var pcm;
    var payload;

    if (!state.lifted || !state.remoteSession || state.audioInFlight >= MAX_AUDIO_IN_FLIGHT) {
      state.audioDropped += 1;
      updateDebug();
      return;
    }

    pcm = encodePcmBase64(samples);
    payload = {
      session: state.sessionId,
      seq: state.audioSeq += 1,
      sampleRate: TARGET_SAMPLE_RATE,
      channel: talkChannel(),
      pcm: pcm
    };

    state.audioInFlight += 1;
    sendEnvelope("audio", payload, state.other)
      .then(function () {
        state.audioTxChunks += 1;
        state.audioTxBytes += Math.floor(pcm.length * 3 / 4);
        updateDebug();
      })
      .catch(function () {
        state.audioDropped += 1;
        updateDebug();
      })
      .then(function () {
        state.audioInFlight = Math.max(0, state.audioInFlight - 1);
        updateDebug();
      });
  }

  function receiveAudioChunk(payload) {
    var samples;
    var seq = Number(payload.seq) || 0;
    var sampleRate = Number(payload.sampleRate) || TARGET_SAMPLE_RATE;

    if (!payload.pcm || seq && seq <= state.lastRemoteAudioSeq) {
      return;
    }

    if (seq) {
      state.lastRemoteAudioSeq = seq;
    }

    samples = decodePcmBase64(payload.pcm);
    state.audioRxChunks += 1;
    state.audioRxBytes += samples.length * 2;
    debug.remoteAudio = (payload.channel || "remote") + " " + sampleRate + " Hz pcm";
    debug.audioPlay = "queue";
    playSamples(samples, sampleRate);
    updateDebug();
  }

  function playSamples(samples, sampleRate) {
    var context = ensureAudioContext();
    var buffer = context.createBuffer(1, samples.length, sampleRate);
    var source = context.createBufferSource();
    var startAt;
    var lag;

    buffer.getChannelData(0).set(samples);
    source.buffer = buffer;
    source._callMomDone = false;
    source.onended = function () {
      source._callMomDone = true;
    };

    if (context.resume) {
      context.resume().catch(function () {});
    }

    cleanupPlaybackSources();
    lag = state.playbackAt ? state.playbackAt - context.currentTime : 0;
    if (lag > MAX_PLAYBACK_LAG_SECONDS) {
      stopScheduledAudio();
      state.playbackAt = 0;
      state.audioDropped += 1;
      debug.audioPlay = "cut backlog";
      updateDebug();
    }

    if (!state.playbackAt || state.playbackAt < context.currentTime) {
      state.playbackAt = context.currentTime + JITTER_SECONDS;
    }

    startAt = state.playbackAt;
    connectSourceToMonoOutput(source, context);
    source.start(startAt);
    state.playbackSources.push(source);
    state.playbackAt = startAt + buffer.duration;
    debug.audioPlay = "ok";
  }

  function connectSourceToMonoOutput(source, context) {
    source.connect(context.destination);
  }

  function cleanupPlaybackSources() {
    state.playbackSources = state.playbackSources.filter(function (source) {
      return !source._callMomDone;
    });
  }

  function stopScheduledAudio() {
    state.playbackSources.forEach(function (source) {
      try {
        source.stop(0);
      } catch (ignore) {}
      source._callMomDone = true;
    });
    state.playbackSources = [];
    state.playbackAt = 0;
  }

  function encodePcmBase64(samples) {
    var binary = "";
    var i;
    var value;

    for (i = 0; i < samples.length; i += 1) {
      value = Math.max(-1, Math.min(1, samples[i]));
      value = value < 0 ? value * 32768 : value * 32767;
      value = Math.round(value);
      binary += String.fromCharCode(value & 255, value >> 8 & 255);
    }

    return btoa(binary);
  }

  function decodePcmBase64(base64) {
    var binary = atob(base64);
    var length = Math.floor(binary.length / 2);
    var samples = new Float32Array(length);
    var i;
    var value;

    for (i = 0; i < length; i += 1) {
      value = binary.charCodeAt(i * 2) | binary.charCodeAt(i * 2 + 1) << 8;
      if (value >= 32768) {
        value -= 65536;
      }
      samples[i] = value / 32768;
    }

    return samples;
  }

  function sendChatMessage() {
    var text = elements.chatInput.value.trim();
    if (!text || !state.textReady) {
      return;
    }

    sendEnvelope("text", {
      session: state.sessionId,
      text: text
    }, state.other).then(function () {
      addChatLine("me", text);
      elements.chatInput.value = "";
    }).catch(function (error) {
      debug.peerError = error.message || String(error);
      updateDebug();
    });
  }

  function receiveTextMessage(payload) {
    if (typeof payload.text === "string" && payload.text) {
      addChatLine("other", payload.text);
    }
  }

  function enableChat(enabled) {
    elements.chatInput.disabled = !enabled;
    elements.chatSend.disabled = !enabled;
    elements.chatInput.placeholder = enabled ? "короткое сообщение" : "ждем серверную связь";
  }

  function resetChat() {
    debug.chat = "нет";
    enableChat(false);
    elements.chatLog.innerHTML = "";
    addChatLine("system", "текстовая связь пойдет через сервер");
  }

  function addChatLine(kind, text) {
    var line = document.createElement("p");
    var label = document.createElement("strong");
    line.className = "chat-line";
    label.textContent = kind === "me" ? "Вы: " : kind === "other" ? "Он: " : "";
    line.appendChild(label);
    line.appendChild(document.createTextNode(text));
    elements.chatLog.appendChild(line);
    elements.chatLog.scrollTop = elements.chatLog.scrollHeight;
  }

  function endCall(message) {
    if (state.lifted) {
      sendEnvelope("bye", { session: state.sessionId }, "all");
    }
    state.lifted = false;
    state.connected = false;
    cleanup();
    setButtonLifted(false);
    openSetup(message || "Для новой сессии проверьте абонента и код связи.");
  }

  function failCall(status, hint) {
    state.lifted = false;
    state.connected = false;
    cleanup();
    setButtonLifted(false);
    setStatus("error", status);
    elements.hint.textContent = hint;
    elements.callButton.disabled = false;
  }

  function cleanup() {
    clearTimeout(state.pollTimer);
    clearTimeout(state.helloTimer);

    if (state.captureNode) {
      state.captureNode.onaudioprocess = null;
      try {
        state.captureNode.disconnect();
      } catch (ignore) {}
      state.captureNode = null;
    }

    if (state.inputSource) {
      try {
        state.inputSource.disconnect();
      } catch (ignore) {}
      state.inputSource = null;
    }

    if (state.muteGain) {
      try {
        state.muteGain.disconnect();
      } catch (ignore) {}
      state.muteGain = null;
    }

    if (state.localStream) {
      state.localStream.getTracks().forEach(function (track) {
        track.stop();
      });
      state.localStream = null;
    }

    state.captureSamples = [];
    state.audioInFlight = 0;
    state.textReady = false;
    debug.localAudio = "нет";
    debug.remoteAudio = "нет";
    debug.audioPlay = "нет";
    debug.peerOpen = false;
    debug.server = "нет";
    debug.signaling = "нет";
    enableChat(false);
    updateDebug();
  }

  function setButtonLifted(lifted) {
    elements.callButton.classList.toggle("active", lifted);
    elements.callButton.setAttribute("aria-label", lifted ? "Положить трубку" : "Снять трубку");
    elements.callButton.title = lifted ? "Положить трубку" : "Снять трубку";
  }

  function setStatus(kind, text) {
    elements.lamp.className = "lamp lamp-" + kind;
    elements.statusText.textContent = text;
  }

  function buildPeerId(person) {
    return PEER_PREFIX + "-" + state.roomHash + "-" + person;
  }

  function talkChannel() {
    return state.me === "1" ? "left" : "right";
  }

  function listenChannel() {
    return state.me === "1" ? "right" : "left";
  }

  function channelDescription() {
    if (!state.me) {
      return "нет";
    }

    return "передаю " + talkChannel() + ", принимаю " + listenChannel() + ", слушаю моно";
  }

  function hashString(text) {
    var hash = 2166136261;
    var i;
    for (i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
    }
    return (hash >>> 0).toString(16);
  }

  function createSessionId() {
    var random = "";
    var values;
    var i;

    if (window.crypto && window.crypto.getRandomValues) {
      values = new Uint32Array(2);
      window.crypto.getRandomValues(values);
      random = values[0].toString(16) + values[1].toString(16);
    } else {
      random = Math.floor(Math.random() * 0x100000000).toString(16);
    }

    for (i = random.length; i < 12; i += 1) {
      random += "0";
    }

    return Date.now().toString(36) + "-" + random.slice(0, 12);
  }

  function describeTracks(tracks) {
    if (!tracks || !tracks.length) {
      return "нет";
    }

    return tracks
      .map(function (track) {
        return [
          track.kind || "track",
          track.enabled === false ? "выкл" : "вкл",
          track.readyState || "state?"
        ].join("/");
      })
      .join(", ");
  }

  function updateDebug() {
    if (!elements.debugInfo) {
      return;
    }

    elements.debugInfo.textContent = [
      "версия: v23-pull-sync-relay",
      "режим: серверное двухканальное реле",
      "signalingUrl: " + SIGNAL_URL,
      "абонент: " + (state.me || "не выбран"),
      "каналы: " + channelDescription(),
      "peerId: " + (debug.peerId || "нет"),
      "peer: " + (debug.peerOpen ? "open" : "closed"),
      "сервер: " + debug.server,
      "сигналинг: " + debug.signaling,
      "микрофон: " + debug.mic,
      "локальный аудио: " + debug.localAudio,
      "звонок: " + debug.call,
      "ice: не используется",
      "pc: не используется",
      "маршрут: PHP channel relay",
      "аудио rx: " + state.audioRxChunks + " чанков, " + state.audioRxBytes + " байт",
      "аудио tx: " + state.audioTxChunks + " чанков, " + state.audioTxBytes + " байт, drop " + state.audioDropped,
      "входящий аудио: " + debug.remoteAudio,
      "audio.play: " + debug.audioPlay,
      "текст: " + debug.chat,
      "ошибка: " + (debug.peerError || "нет"),
      "браузер: " + navigator.userAgent
    ].join("\n");
  }

  function requestJson(method, url, body) {
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.open(method, url, true);
      xhr.setRequestHeader("Accept", "application/json");
      if (method === "POST") {
        xhr.setRequestHeader("Content-Type", "application/json");
      }
      xhr.onreadystatechange = function () {
        var data;
        if (xhr.readyState !== 4) {
          return;
        }

        if (xhr.status < 200 || xhr.status >= 300) {
          reject(new Error("signal HTTP " + xhr.status + ": " + (xhr.responseText || "").slice(0, 80)));
          return;
        }

        try {
          data = JSON.parse(xhr.responseText || "{}");
        } catch (error) {
          reject(new Error("signal bad JSON: " + (xhr.responseText || "").slice(0, 80)));
          return;
        }

        if (!data.ok) {
          reject(new Error((data.error || "signal error") + " HTTP " + xhr.status));
          return;
        }

        resolve(data);
      };
      xhr.onerror = function () {
        reject(new Error("signal network"));
      };
      xhr.ontimeout = function () {
        reject(new Error("signal timeout"));
      };
      xhr.timeout = 10000;
      xhr.send(body ? JSON.stringify(body) : null);
    });
  }

  function encodeQuery(values) {
    var parts = [];
    Object.keys(values).forEach(function (key) {
      parts.push(encodeURIComponent(key) + "=" + encodeURIComponent(values[key]));
    });
    return parts.join("&");
  }

  function copyDebugLog() {
    var text = elements.debugInfo ? elements.debugInfo.textContent : "";

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        elements.copyLogButton.textContent = "Скопировано";
        setTimeout(resetCopyButton, 1200);
      }).catch(function () {
        fallbackCopy(text);
      });
      return;
    }

    fallbackCopy(text);
  }

  function fallbackCopy(text) {
    var textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "readonly");
    textarea.style.position = "fixed";
    textarea.style.left = "-9999px";
    document.body.appendChild(textarea);
    textarea.select();

    try {
      document.execCommand("copy");
      elements.copyLogButton.textContent = "Скопировано";
    } catch (error) {
      elements.copyLogButton.textContent = "Не скопировалось";
    }

    document.body.removeChild(textarea);
    setTimeout(resetCopyButton, 1200);
  }

  function resetCopyButton() {
    elements.copyLogButton.textContent = "Скопировать лог";
  }
})();
