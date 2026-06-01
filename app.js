(function () {
  var PEER_PREFIX = "call-mom-simple-v1";
  var RETRY_DELAY_MS = 2500;
  var CHAT_RETRY_DELAY_MS = 3000;
  var ICE_SERVERS = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    {
      urls: ["turn:eu-0.turn.peerjs.com:3478", "turn:us-0.turn.peerjs.com:3478"],
      username: "peerjs",
      credential: "peerjsp"
    }
  ];

  var state = {
    me: null,
    other: null,
    key: "",
    roomHash: "",
    confirmed: false,
    lifted: false,
    connected: false,
    peer: null,
    localStream: null,
    activeCall: null,
    chatConnection: null,
    dialTimer: null,
    chatTimer: null
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
    chatSend: document.getElementById("chatSend")
  };

  document.documentElement.setAttribute("data-peer-loaded", window.Peer ? "true" : "false");

  init();

  function init() {
    var params = readParams();
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

    window.addEventListener("beforeunload", cleanup);
    refreshSetupState();
  }

  function readParams() {
    var text = "";
    if (window.location.hash && window.location.hash.length > 1) {
      text = window.location.hash.slice(1);
    } else if (window.location.search && window.location.search.length > 1) {
      text = window.location.search.slice(1);
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
    if (!window.Peer) {
      failCall("PeerJS не загрузился", "Проверьте интернет и обновите страницу.");
      return;
    }

    state.lifted = true;
    state.connected = false;
    state.roomHash = hashString(state.key);
    resetChat();
    setButtonLifted(true);
    closeSetup();
    setStatus("waiting", "Запрашиваем микрофон");
    elements.hint.textContent = "Разрешите микрофон и дождитесь второго абонента.";

    getAudioStream()
      .then(function (stream) {
        state.localStream = stream;
        createPeer();
      })
      .catch(function (error) {
        console.error(error);
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

  function createPeer() {
    var peerId = buildPeerId(state.me);

    state.peer = new Peer(peerId, {
      debug: 0,
      config: {
        iceServers: ICE_SERVERS,
        sdpSemantics: "unified-plan"
      }
    });

    state.peer.on("open", function () {
      setStatus("waiting", "Ждем второго абонента");
      elements.hint.textContent = "Связь включена. Зеленая лампочка загорится после соединения.";
      dialNow();
      connectChatNow();
    });

    state.peer.on("call", function (call) {
      if (!state.lifted || !state.localStream) {
        call.close();
        return;
      }
      attachCall(call, true);
    });

    state.peer.on("connection", attachChatConnection);

    state.peer.on("error", function (error) {
      console.error(error);
      if (String(error.type) === "unavailable-id") {
        failCall("Абонент уже открыт", "Закройте старую вкладку этого абонента и попробуйте снова.");
        return;
      }

      if (state.lifted && !state.connected) {
        setStatus("waiting", "Второй абонент еще не на линии");
        scheduleDial();
        scheduleChatConnect();
      }
    });
  }

  function dialNow() {
    clearTimeout(state.dialTimer);
    dialOther();
  }

  function scheduleDial() {
    clearTimeout(state.dialTimer);
    if (!state.lifted || state.connected) {
      return;
    }
    state.dialTimer = setTimeout(dialOther, RETRY_DELAY_MS);
  }

  function dialOther() {
    if (!state.peer || !state.peer.open || !state.localStream || state.connected) {
      scheduleDial();
      return;
    }

    attachCall(state.peer.call(buildPeerId(state.other), state.localStream), false);
    scheduleDial();
  }

  function attachCall(call, incoming) {
    if (state.activeCall && state.connected) {
      call.close();
      return;
    }

    state.activeCall = call;

    if (incoming) {
      call.answer(state.localStream);
    }

    call.on("stream", function (remoteStream) {
      state.connected = true;
      clearTimeout(state.dialTimer);
      elements.remoteAudio.srcObject = remoteStream;
      elements.remoteAudio.muted = false;
      elements.remoteAudio.volume = 1;
      elements.remoteAudio.play().catch(function (error) {
        console.warn("Audio playback was blocked", error);
      });
      setStatus("live", "На линии");
      elements.hint.textContent = "Можно говорить. Чтобы выйти, закройте страницу или нажмите красную трубку.";
      addChatLine("system", "аудиосвязь установлена");
    });

    call.on("close", function () {
      if (!state.lifted) {
        return;
      }

      var wasConnected = state.connected;
      state.connected = false;
      state.activeCall = null;

      if (wasConnected) {
        endCall("Связь завершена. Для новой сессии проверьте абонента и код связи.");
      } else {
        setStatus("waiting", "Соединение прервано");
        elements.hint.textContent = "Пробуем соединиться снова.";
        scheduleDial();
      }
    });

    call.on("error", function (error) {
      console.error(error);
      if (state.lifted && !state.connected) {
        scheduleDial();
      }
    });
  }

  function connectChatNow() {
    clearTimeout(state.chatTimer);
    connectChat();
  }

  function scheduleChatConnect() {
    clearTimeout(state.chatTimer);
    if (!state.lifted || hasOpenChat()) {
      return;
    }
    state.chatTimer = setTimeout(connectChat, CHAT_RETRY_DELAY_MS);
  }

  function connectChat() {
    if (!state.peer || !state.peer.open || hasOpenChat()) {
      scheduleChatConnect();
      return;
    }

    attachChatConnection(state.peer.connect(buildPeerId(state.other), { reliable: true }));
    scheduleChatConnect();
  }

  function attachChatConnection(connection) {
    if (state.chatConnection && state.chatConnection.open) {
      connection.close();
      return;
    }

    state.chatConnection = connection;

    connection.on("open", function () {
      clearTimeout(state.chatTimer);
      enableChat(true);
      addChatLine("system", "текстовая связь установлена");
    });

    connection.on("data", function (message) {
      if (typeof message === "string") {
        addChatLine("other", message);
      }
    });

    connection.on("close", function () {
      if (state.chatConnection === connection) {
        state.chatConnection = null;
        enableChat(false);
        if (state.lifted) {
          addChatLine("system", "текстовая связь прервана");
          scheduleChatConnect();
        }
      }
    });

    connection.on("error", function (error) {
      console.error(error);
      if (state.chatConnection === connection) {
        state.chatConnection = null;
      }
      enableChat(false);
      scheduleChatConnect();
    });
  }

  function sendChatMessage() {
    var text = elements.chatInput.value.trim();
    if (!text || !hasOpenChat()) {
      return;
    }

    state.chatConnection.send(text);
    addChatLine("me", text);
    elements.chatInput.value = "";
  }

  function hasOpenChat() {
    return Boolean(state.chatConnection && state.chatConnection.open);
  }

  function enableChat(enabled) {
    elements.chatInput.disabled = !enabled;
    elements.chatSend.disabled = !enabled;
    elements.chatInput.placeholder = enabled ? "короткое сообщение" : "ждем текстовую связь";
  }

  function resetChat() {
    clearTimeout(state.chatTimer);
    state.chatConnection = null;
    enableChat(false);
    elements.chatLog.innerHTML = "";
    addChatLine("system", "текстовая связь ждет второго абонента");
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
    clearTimeout(state.dialTimer);
    clearTimeout(state.chatTimer);

    if (state.activeCall) {
      state.activeCall.close();
      state.activeCall = null;
    }

    if (state.chatConnection) {
      state.chatConnection.close();
      state.chatConnection = null;
    }

    if (state.peer) {
      state.peer.destroy();
      state.peer = null;
    }

    if (state.localStream) {
      state.localStream.getTracks().forEach(function (track) {
        track.stop();
      });
      state.localStream = null;
    }

    if (elements.remoteAudio.srcObject) {
      elements.remoteAudio.srcObject.getTracks().forEach(function (track) {
        track.stop();
      });
      elements.remoteAudio.srcObject = null;
    }

    enableChat(false);
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

  function hashString(text) {
    var hash = 2166136261;
    for (var i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
    }
    return (hash >>> 0).toString(16);
  }
})();
