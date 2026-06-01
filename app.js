(function () {
  document.documentElement.dataset.peerLoaded = window.Peer ? "true" : "false";

  const PEER_PREFIX = "call-mom-v1";
  const RETRY_DELAY_MS = 2400;
  const CHAT_RETRY_DELAY_MS = 2500;
  const TAKEOVER_TIMEOUT_MS = 7000;
  const TAKEOVER_RETRY_DELAY_MS = 1300;
  const JITTER_BUFFER_TARGET_SECONDS = 0.8;
  const ICE_SERVERS = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    {
      urls: ["turn:eu-0.turn.peerjs.com:3478", "turn:us-0.turn.peerjs.com:3478"],
      username: "peerjs",
      credential: "peerjsp"
    }
  ];
  const CALL_OPTIONS = {
    sdpTransform: preferResilientOpus
  };

  const state = {
    me: null,
    other: null,
    key: "",
    settingsConfirmed: false,
    lifted: false,
    connected: false,
    takeoverAttempted: false,
    takeoverPeer: null,
    takeoverConnection: null,
    takeoverTimer: null,
    peer: null,
    localStream: null,
    activeCall: null,
    chatConnection: null,
    chatRetryTimer: null,
    audioContext: null,
    retryTimer: null,
    roomHash: ""
  };

  const elements = {
    lamp: document.querySelector("#lamp"),
    statusText: document.querySelector("#statusText"),
    roleText: document.querySelector("#roleText"),
    setupDialog: document.querySelector("#setupDialog"),
    setupForm: document.querySelector("#setupForm"),
    setupSubmit: document.querySelector("#setupSubmit"),
    secretKey: document.querySelector("#secretKey"),
    personButtons: Array.from(document.querySelectorAll("[data-person]")),
    callButton: document.querySelector("#callButton"),
    audioButton: document.querySelector("#audioButton"),
    chatLog: document.querySelector("#chatLog"),
    chatForm: document.querySelector("#chatForm"),
    chatInput: document.querySelector("#chatInput"),
    chatSend: document.querySelector("#chatSend"),
    hint: document.querySelector("#hint"),
    remoteAudio: document.querySelector("#remoteAudio")
  };

  const params = readParams();
  const storedPerson = localStorage.getItem("callMomPerson") || "";

  elements.secretKey.value = params.key || "";
  choosePerson(params.me || storedPerson, false);
  refreshSetupState();
  openSetup("Проверьте абонента и код связи.");

  elements.secretKey.addEventListener("input", refreshSetupState);

  elements.setupForm.addEventListener("submit", (event) => {
    event.preventDefault();
    unlockAudioOutput();
    confirmSetup();
  });

  elements.personButtons.forEach((button) => {
    button.addEventListener("click", () => {
      choosePerson(button.dataset.person, false);
      refreshSetupState();
    });
  });

  elements.callButton.addEventListener("click", () => {
    unlockAudioOutput();

    if (state.lifted) {
      endCall("Трубка положена");
      return;
    }

    liftHandset().catch((error) => {
      console.error(error);
      failCall(error.message || "Не удалось начать звонок", "Проверьте доступ к микрофону и попробуйте снова.");
    });
  });

  elements.audioButton.addEventListener("click", () => {
    playRemoteAudio(true);
  });

  elements.chatForm.addEventListener("submit", (event) => {
    event.preventDefault();
    sendChatMessage();
  });

  window.addEventListener("beforeunload", () => {
    cleanup();
  });

  function readParams() {
    const hash = new URLSearchParams(window.location.hash.slice(1));
    const query = new URLSearchParams(window.location.search);

    return {
      me: hash.get("me") || query.get("me") || "",
      key: hash.get("key") || query.get("key") || ""
    };
  }

  function choosePerson(person, persist) {
    if (person !== "1" && person !== "2") {
      state.me = null;
      state.other = null;
    } else {
      state.me = person;
      state.other = person === "1" ? "2" : "1";
      if (persist) {
        localStorage.setItem("callMomPerson", person);
      }
    }

    elements.personButtons.forEach((button) => {
      button.classList.toggle("active", button.dataset.person === state.me);
    });

    elements.roleText.textContent = state.me ? `Вы: абонент ${state.me}` : "Выберите абонента";
  }

  function refreshSetupState() {
    state.key = elements.secretKey.value.trim();

    const ready = Boolean(state.me && state.key);
    elements.setupSubmit.disabled = !ready;
    elements.callButton.disabled = !canCall();

    if (!ready) {
      setStatus("idle", "Нужны абонент и код связи");
      elements.hint.textContent = "Один код связи должен быть одинаковым на двух устройствах.";
    } else if (!state.settingsConfirmed) {
      setStatus("idle", "Проверьте настройки");
      elements.hint.textContent = "Подтвердите абонента и код связи перед звонком.";
    } else if (!state.lifted) {
      setStatus("idle", "Готово");
      elements.hint.textContent = "Нажмите трубку. Второй абонент делает то же самое на своей странице.";
    }
  }

  function confirmSetup() {
    if (!state.me || !state.key) {
      refreshSetupState();
      return;
    }

    localStorage.setItem("callMomPerson", state.me);
    state.takeoverAttempted = false;
    state.settingsConfirmed = true;
    closeSetup();
    refreshSetupState();
  }

  function openSetup(message) {
    state.settingsConfirmed = false;
    elements.setupDialog.hidden = false;
    elements.callButton.disabled = true;
    refreshSetupState();
    elements.hint.textContent = message;

    window.requestAnimationFrame(() => {
      elements.secretKey.focus();
      elements.secretKey.select();
    });
  }

  function closeSetup() {
    elements.setupDialog.hidden = true;
  }

  function canCall() {
    return Boolean(state.settingsConfirmed && state.me && state.key && !state.lifted);
  }

  async function liftHandset() {
    if (!window.Peer) {
      throw new Error("PeerJS не загрузился. Проверьте интернет и обновите страницу.");
    }

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error("Этот браузер не дает доступ к микрофону на этой странице.");
    }

    state.lifted = true;
    state.connected = false;
    state.roomHash = await shortHash(state.key);
    elements.audioButton.hidden = true;
    resetChat();

    elements.callButton.classList.add("active");
    elements.callButton.disabled = false;
    elements.callButton.setAttribute("aria-label", "Положить трубку");
    elements.callButton.title = "Положить трубку";
    closeSetup();
    setStatus("waiting", "Запрашиваем микрофон");
    elements.hint.textContent = "Разрешите доступ к микрофону, затем дождитесь второго абонента.";

    state.localStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      },
      video: false
    });

    const audioTracks = state.localStream.getAudioTracks();
    if (!audioTracks.length) {
      throw new Error("Браузер не вернул аудиотрек микрофона.");
    }

    createPeer();
  }

  function createPeer() {
    const peerId = buildPeerId(state.me);

    state.peer = new Peer(peerId, {
      debug: 1,
      config: {
        iceServers: ICE_SERVERS,
        iceCandidatePoolSize: 4
      }
    });

    state.peer.on("open", () => {
      setStatus("waiting", "Ждем второго абонента");
      elements.hint.textContent = "Связь включена. Зеленая лампочка загорится после соединения.";
      scheduleChatConnectNow();
      scheduleDialNow();
    });

    state.peer.on("call", (call) => {
      if (!state.lifted || !state.localStream) {
        call.close();
        return;
      }

      attachCall(call, true);
    });

    state.peer.on("connection", (connection) => {
      if (connection.metadata && connection.metadata.type === "takeover") {
        attachControlConnection(connection);
      } else {
        attachChatConnection(connection);
      }
    });

    state.peer.on("disconnected", () => {
      if (state.lifted && !state.connected) {
        setStatus("waiting", "Восстанавливаем сигналинг");
        state.peer.reconnect();
      }
    });

    state.peer.on("error", (error) => {
      console.error(error);
      if (String(error.type) === "unavailable-id") {
        if (!state.takeoverAttempted) {
          startTakeover().catch((takeoverError) => {
            console.error(takeoverError);
            failCall("Абонент занят на другом устройстве", "Старая вкладка не освободила линию. Закройте ее или подождите минуту и попробуйте снова.");
          });
        } else {
          failCall("Абонент занят на другом устройстве", "Старая вкладка еще держит линию. Закройте ее или подождите минуту и попробуйте снова.");
        }
        return;
      }

      if (state.lifted && !state.connected) {
        setStatus("waiting", "Второй абонент еще не на линии");
        scheduleDial();
      }
    });
  }

  function scheduleDialNow() {
    window.clearTimeout(state.retryTimer);
    dialOther();
  }

  function scheduleDial() {
    window.clearTimeout(state.retryTimer);
    if (!state.lifted || state.connected) {
      return;
    }

    state.retryTimer = window.setTimeout(dialOther, RETRY_DELAY_MS);
  }

  function dialOther() {
    if (!state.peer || !state.peer.open || !state.localStream || state.connected) {
      scheduleDial();
      return;
    }

    const call = state.peer.call(buildPeerId(state.other), state.localStream, CALL_OPTIONS);
    attachCall(call, false);
    scheduleDial();
  }

  function scheduleChatConnectNow() {
    window.clearTimeout(state.chatRetryTimer);
    connectChat();
  }

  function scheduleChatConnect() {
    window.clearTimeout(state.chatRetryTimer);
    if (!state.lifted || hasOpenChat()) {
      return;
    }

    state.chatRetryTimer = window.setTimeout(connectChat, CHAT_RETRY_DELAY_MS);
  }

  function connectChat() {
    if (!state.peer || !state.peer.open || hasOpenChat()) {
      scheduleChatConnect();
      return;
    }

    const connection = state.peer.connect(buildPeerId(state.other), {
      reliable: true,
      metadata: { type: "chat" }
    });
    attachChatConnection(connection);
    scheduleChatConnect();
  }

  function attachChatConnection(connection) {
    if (state.chatConnection && state.chatConnection !== connection) {
      if (state.chatConnection.open) {
        connection.close();
        return;
      }

      state.chatConnection.close();
    }

    state.chatConnection = connection;

    connection.on("open", () => {
      window.clearTimeout(state.chatRetryTimer);
      enableChat(true);
      addChatLine("system", "текстовая связь установлена");
    });

    connection.on("data", (message) => {
      if (!message || message.type !== "chat") {
        return;
      }

      addChatLine("other", message.text);
    });

    connection.on("close", () => {
      if (state.chatConnection === connection) {
        state.chatConnection = null;
        enableChat(false);
        if (state.lifted) {
          addChatLine("system", "текстовая связь прервана");
          scheduleChatConnect();
        }
      }
    });

    connection.on("error", (error) => {
      console.error(error);
      if (state.chatConnection === connection) {
        state.chatConnection = null;
      }
      enableChat(false);
      if (state.lifted) {
        scheduleChatConnect();
      }
    });
  }

  function sendChatMessage() {
    const text = elements.chatInput.value.trim();
    if (!text || !hasOpenChat()) {
      return;
    }

    state.chatConnection.send({ type: "chat", text });
    addChatLine("me", text);
    elements.chatInput.value = "";
    elements.chatInput.focus();
  }

  function hasOpenChat() {
    return Boolean(state.chatConnection && state.chatConnection.open);
  }

  function enableChat(enabled) {
    elements.chatInput.disabled = !enabled;
    elements.chatSend.disabled = !enabled;
  }

  function resetChat() {
    window.clearTimeout(state.chatRetryTimer);
    state.chatConnection = null;
    enableChat(false);
    elements.chatLog.replaceChildren();
    addChatLine("system", "текстовая связь ждет второго абонента");
  }

  function addChatLine(kind, text) {
    const line = document.createElement("p");
    line.className = "chat-line";

    const label = document.createElement("strong");
    label.textContent = kind === "me" ? "Вы: " : kind === "other" ? "Он: " : "";
    line.append(label, document.createTextNode(text));

    elements.chatLog.append(line);
    elements.chatLog.scrollTop = elements.chatLog.scrollHeight;
  }

  function attachCall(call, incoming) {
    if (state.activeCall && state.connected) {
      call.close();
      return;
    }

    if (incoming) {
      call.answer(state.localStream, CALL_OPTIONS);
    }

    state.activeCall = call;

    call.on("stream", (remoteStream) => {
      const remoteTracks = remoteStream.getAudioTracks();
      state.connected = true;
      window.clearTimeout(state.retryTimer);
      tuneReceiverBuffer(call);
      elements.remoteAudio.srcObject = remoteStream;
      setStatus("live", "На линии");
      elements.hint.textContent = remoteTracks.length
        ? "Можно говорить. Если тишина, нажмите «Включить звук»."
        : "Соединение есть, но входящий аудиотрек не пришел.";
      elements.audioButton.hidden = !remoteTracks.length;
      playRemoteAudio(false);
    });

    call.on("close", () => {
      if (state.lifted) {
        const wasConnected = state.connected;
        state.connected = false;
        state.activeCall = null;

        if (wasConnected) {
          endCall("Связь завершена. Для новой сессии проверьте абонента и код связи.");
        } else {
          setStatus("waiting", "Соединение прервано");
          elements.hint.textContent = "Оставьте страницу открытой: пробуем соединиться снова.";
          scheduleDial();
        }
      }
    });

    call.on("error", (error) => {
      console.error(error);
      if (state.lifted && !state.connected) {
        scheduleDial();
      }
    });
  }

  async function unlockAudioOutput() {
    elements.remoteAudio.muted = false;
    elements.remoteAudio.volume = 1;

    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (AudioContextClass) {
      state.audioContext = state.audioContext || new AudioContextClass();
      if (state.audioContext.state === "suspended") {
        try {
          await state.audioContext.resume();
        } catch (error) {
          console.debug("Audio context is still suspended", error);
        }
      }
    }

    if (!elements.remoteAudio.srcObject) {
      return;
    }

    try {
      await elements.remoteAudio.play();
      elements.audioButton.hidden = !(state.connected && hasRemoteAudioTrack());
    } catch (error) {
      console.debug("Audio output is still locked", error);
    }
  }

  async function playRemoteAudio(fromUserGesture) {
    elements.remoteAudio.muted = false;
    elements.remoteAudio.volume = 1;

    try {
      await elements.remoteAudio.play();
      elements.audioButton.hidden = !(state.connected && hasRemoteAudioTrack());
      if (state.connected) {
        elements.hint.textContent = "Звук включен. Можно говорить.";
      }
    } catch (error) {
      console.warn("Remote audio playback was blocked", error);
      elements.audioButton.hidden = false;
      elements.hint.textContent = fromUserGesture
        ? "Браузер все еще блокирует звук. Проверьте громкость и разрешения сайта."
        : "Браузер подключил звонок, но звук нужно включить кнопкой ниже.";
    }
  }

  function hasRemoteAudioTrack() {
    return Boolean(
      elements.remoteAudio.srcObject &&
        elements.remoteAudio.srcObject.getAudioTracks &&
        elements.remoteAudio.srcObject.getAudioTracks().length
    );
  }

  function attachControlConnection(connection) {
    connection.on("data", async (message) => {
      if (!message || message.type !== "takeover") {
        return;
      }

      const expectedProof = await takeoverProof();
      if (message.proof !== expectedProof) {
        return;
      }

      if (connection.open) {
        connection.send({ type: "takeover-ack" });
      }

      window.setTimeout(() => {
        endCall("Эта вкладка отключена: абонент открыт в другом месте.");
      }, 180);
    });
  }

  async function startTakeover() {
    state.takeoverAttempted = true;
    destroyPeerOnly();
    setStatus("waiting", "Освобождаем абонента");
    elements.hint.textContent = "Нашли старую вкладку с этим абонентом. Просим ее положить трубку.";

    const proof = await takeoverProof();
    const takeoverId = `${PEER_PREFIX}-takeover-${state.roomHash}-${state.me}-${randomToken()}`;

    await new Promise((resolve, reject) => {
      let finished = false;

      const finish = (error) => {
        if (finished) {
          return;
        }

        finished = true;
        window.clearTimeout(state.takeoverTimer);
        destroyTakeoverPeer();
        error ? reject(error) : resolve();
      };

      state.takeoverTimer = window.setTimeout(() => {
        finish(new Error("Takeover timed out"));
      }, TAKEOVER_TIMEOUT_MS);

      state.takeoverPeer = new Peer(takeoverId, {
        debug: 1,
        config: { iceServers: ICE_SERVERS }
      });

      state.takeoverPeer.on("open", () => {
        state.takeoverConnection = state.takeoverPeer.connect(buildPeerId(state.me), {
          reliable: true,
          metadata: { type: "takeover" }
        });

        state.takeoverConnection.on("open", () => {
          state.takeoverConnection.send({ type: "takeover", proof });
        });

        state.takeoverConnection.on("data", (message) => {
          if (message && message.type === "takeover-ack") {
            finish();
          }
        });

        state.takeoverConnection.on("error", finish);
        state.takeoverConnection.on("close", () => {
          if (!finished) {
            finish(new Error("Takeover connection closed"));
          }
        });
      });

      state.takeoverPeer.on("error", finish);
    });

    if (!state.lifted || !state.localStream) {
      return;
    }

    setStatus("waiting", "Абонент освобожден");
    elements.hint.textContent = "Пробуем занять линию на этом устройстве.";
    window.setTimeout(() => {
      if (state.lifted && state.localStream && !state.peer) {
        createPeer();
      }
    }, TAKEOVER_RETRY_DELAY_MS);
  }

  function destroyPeerOnly() {
    if (state.peer) {
      state.peer.destroy();
      state.peer = null;
    }
  }

  function destroyTakeoverPeer() {
    window.clearTimeout(state.takeoverTimer);
    state.takeoverTimer = null;

    if (state.takeoverConnection) {
      state.takeoverConnection.close();
      state.takeoverConnection = null;
    }

    if (state.takeoverPeer) {
      state.takeoverPeer.destroy();
      state.takeoverPeer = null;
    }
  }

  function takeoverProof() {
    return shortHash(`takeover:${state.key}`);
  }

  function tuneReceiverBuffer(call) {
    const peerConnection = call && call.peerConnection;
    if (!peerConnection || !peerConnection.getReceivers) {
      return;
    }

    peerConnection.getReceivers().forEach((receiver) => {
      const track = receiver.track;
      if (track && track.kind === "audio" && "jitterBufferTarget" in receiver) {
        try {
          receiver.jitterBufferTarget = JITTER_BUFFER_TARGET_SECONDS;
        } catch (error) {
          console.debug("Audio jitter buffer target is not writable here", error);
        }
      }
    });
  }

  function preferResilientOpus(sdp) {
    const opusMatch = sdp.match(/^a=rtpmap:(\d+) opus\/48000\/2$/im);
    if (!opusMatch) {
      return sdp;
    }

    const payload = opusMatch[1];
    const fmtpLine = new RegExp(`^a=fmtp:${payload} (.*)$`, "im");
    const opusOptions = ["useinbandfec=1", "usedtx=1", "maxaveragebitrate=24000"];

    if (fmtpLine.test(sdp)) {
      return sdp.replace(fmtpLine, (line, values) => {
        const existing = values
          .split(";")
          .map((value) => value.trim().toLowerCase())
          .filter(Boolean);
        const missing = opusOptions.filter((option) => {
          const optionKey = option.split("=")[0].toLowerCase();
          return !existing.some((value) => value.split("=")[0] === optionKey);
        });

        return missing.length ? `${line};${missing.join(";")}` : line;
      });
    }

    return sdp.replace(
      new RegExp(`^(a=rtpmap:${payload} opus\\/48000\\/2\\r?\\n)`, "im"),
      `$1a=fmtp:${payload} ${opusOptions.join(";")}\r\n`
    );
  }

  function buildPeerId(person) {
    return `${PEER_PREFIX}-${state.roomHash}-${person}`;
  }

  function randomToken() {
    const bytes = new Uint8Array(8);
    crypto.getRandomValues(bytes);
    return Array.from(bytes)
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  }

  async function shortHash(value) {
    const encoder = new TextEncoder();
    const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
    const bytes = Array.from(new Uint8Array(digest));
    return bytes
      .slice(0, 12)
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  }

  function setStatus(kind, text) {
    elements.lamp.className = `lamp lamp-${kind}`;
    elements.statusText.textContent = text;
  }

  function endCall(message) {
    state.lifted = false;
    state.connected = false;
    cleanup();
    state.takeoverAttempted = false;
    elements.callButton.classList.remove("active");
    elements.callButton.setAttribute("aria-label", "Снять трубку");
    elements.callButton.title = "Снять трубку";
    elements.remoteAudio.srcObject = null;
    elements.audioButton.hidden = true;
    openSetup(message || "Для новой сессии проверьте абонента и код связи.");
  }

  function failCall(statusText, hintText) {
    state.lifted = false;
    state.connected = false;
    cleanup();
    state.takeoverAttempted = false;
    elements.callButton.classList.remove("active");
    elements.callButton.setAttribute("aria-label", "Снять трубку");
    elements.callButton.title = "Снять трубку";
    elements.remoteAudio.srcObject = null;
    elements.audioButton.hidden = true;
    elements.callButton.disabled = !canCall();
    setStatus("error", statusText);
    elements.hint.textContent = hintText;
  }

  function cleanup() {
    window.clearTimeout(state.retryTimer);
    window.clearTimeout(state.chatRetryTimer);
    destroyTakeoverPeer();

    if (state.chatConnection) {
      state.chatConnection.close();
      state.chatConnection = null;
    }
    enableChat(false);

    if (state.activeCall) {
      state.activeCall.close();
      state.activeCall = null;
    }

    if (state.peer) {
      state.peer.destroy();
      state.peer = null;
    }

    if (state.localStream) {
      state.localStream.getTracks().forEach((track) => track.stop());
      state.localStream = null;
    }

    if (elements.remoteAudio.srcObject) {
      elements.remoteAudio.srcObject.getTracks().forEach((track) => track.stop());
      elements.remoteAudio.srcObject = null;
    }
  }
})();
