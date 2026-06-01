(function () {
  document.documentElement.dataset.peerLoaded = window.Peer ? "true" : "false";

  const PEER_PREFIX = "call-mom-v1";
  const RETRY_DELAY_MS = 2400;
  const ICE_SERVERS = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" }
  ];

  const state = {
    me: null,
    other: null,
    key: "",
    lifted: false,
    connected: false,
    peer: null,
    localStream: null,
    activeCall: null,
    retryTimer: null,
    roomHash: ""
  };

  const elements = {
    lamp: document.querySelector("#lamp"),
    statusText: document.querySelector("#statusText"),
    roleText: document.querySelector("#roleText"),
    setup: document.querySelector("#setup"),
    secretKey: document.querySelector("#secretKey"),
    personButtons: Array.from(document.querySelectorAll("[data-person]")),
    callButton: document.querySelector("#callButton"),
    hint: document.querySelector("#hint"),
    remoteAudio: document.querySelector("#remoteAudio")
  };

  const params = readParams();
  const storedKey = localStorage.getItem("callMomKey") || "";
  const storedPerson = localStorage.getItem("callMomPerson") || "";

  elements.secretKey.value = params.key || storedKey;
  choosePerson(params.me || storedPerson, false);
  refreshSetupState();

  elements.secretKey.addEventListener("input", refreshSetupState);

  elements.personButtons.forEach((button) => {
    button.addEventListener("click", () => {
      choosePerson(button.dataset.person, true);
      refreshSetupState();
    });
  });

  elements.callButton.addEventListener("click", () => {
    if (state.lifted) {
      endCall("Трубка положена");
      return;
    }

    liftHandset().catch((error) => {
      console.error(error);
      failCall(error.message || "Не удалось начать звонок", "Проверьте доступ к микрофону и попробуйте снова.");
    });
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

    if (state.key) {
      localStorage.setItem("callMomKey", state.key);
    }

    const ready = Boolean(state.me && state.key);
    elements.callButton.disabled = !ready;
    elements.setup.classList.toggle("hidden", ready);

    if (!ready) {
      setStatus("idle", "Нужны абонент и код связи");
      elements.hint.textContent = "Один код связи должен быть одинаковым на двух устройствах.";
    } else if (!state.lifted) {
      setStatus("idle", "Готово");
      elements.hint.textContent = "Нажмите трубку. Второй абонент делает то же самое на своей странице.";
    }
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

    elements.callButton.classList.add("active");
    elements.callButton.setAttribute("aria-label", "Положить трубку");
    elements.setup.classList.add("hidden");
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

    createPeer();
  }

  function createPeer() {
    const peerId = buildPeerId(state.me);

    state.peer = new Peer(peerId, {
      debug: 1,
      config: { iceServers: ICE_SERVERS }
    });

    state.peer.on("open", () => {
      setStatus("waiting", "Ждем второго абонента");
      elements.hint.textContent = "Связь включена. Зеленая лампочка загорится после соединения.";
      scheduleDialNow();
    });

    state.peer.on("call", (call) => {
      if (!state.lifted || !state.localStream) {
        call.close();
        return;
      }

      attachCall(call, true);
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
        failCall("Этот абонент уже открыт в другой вкладке", "Закройте лишнюю вкладку или обновите страницу через несколько секунд.");
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

    const call = state.peer.call(buildPeerId(state.other), state.localStream);
    attachCall(call, false);
    scheduleDial();
  }

  function attachCall(call, incoming) {
    if (state.activeCall && state.connected) {
      call.close();
      return;
    }

    if (incoming) {
      call.answer(state.localStream);
    }

    state.activeCall = call;

    call.on("stream", (remoteStream) => {
      state.connected = true;
      window.clearTimeout(state.retryTimer);
      elements.remoteAudio.srcObject = remoteStream;
      elements.remoteAudio.play().catch(() => {
        elements.hint.textContent = "Нажмите трубку еще раз, если браузер не включил звук автоматически.";
      });
      setStatus("live", "На линии");
      elements.hint.textContent = "Можно говорить. Чтобы выйти, просто закройте страницу.";
    });

    call.on("close", () => {
      if (state.lifted) {
        state.connected = false;
        state.activeCall = null;
        setStatus("waiting", "Соединение прервано");
        elements.hint.textContent = "Оставьте страницу открытой: пробуем соединиться снова.";
        scheduleDial();
      }
    });

    call.on("error", (error) => {
      console.error(error);
      if (state.lifted && !state.connected) {
        scheduleDial();
      }
    });
  }

  function buildPeerId(person) {
    return `${PEER_PREFIX}-${state.roomHash}-${person}`;
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
    cleanup();
    state.lifted = false;
    state.connected = false;
    elements.callButton.classList.remove("active");
    elements.callButton.setAttribute("aria-label", "Снять трубку");
    elements.remoteAudio.srcObject = null;
    refreshSetupState();
    elements.hint.textContent = message || "Можно закрыть страницу или позвонить снова.";
  }

  function failCall(statusText, hintText) {
    cleanup();
    state.lifted = false;
    state.connected = false;
    elements.callButton.classList.remove("active");
    elements.callButton.setAttribute("aria-label", "Снять трубку");
    elements.remoteAudio.srcObject = null;
    setStatus("error", statusText);
    elements.hint.textContent = hintText;
  }

  function cleanup() {
    window.clearTimeout(state.retryTimer);

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
  }
})();
