const STORAGE_KEY = "zupium_conversations_v1";

let state = {
  conversations: [],
  activeId: null,
};

let pendingFiles = [];

// isSending: true selama menunggu/menerima balasan AI
// mencegah pesan baru dikirim (anti-spam & anti-bentrok)
let isSending = false;
let activeAbortController = null;
let thinkingTimerId = null;

function initStarfield() {
  const sf = document.getElementById("starfield");
  if (!sf) return;
  const N = 160;
  for (let i = 0; i < N; i++) {
    const s = document.createElement("div");
    s.className = "star-dot";
    const size = Math.random() * 2.2 + 0.4;
    const opacity = Math.random() * 0.7 + 0.1;
    const dur = (Math.random() * 4 + 2).toFixed(1);
    s.style.cssText = `
      left:${Math.random() * 100}%;
      top:${Math.random() * 100}%;
      width:${size}px; height:${size}px;
      --o:${opacity}; --d:${dur}s;
      animation-delay:${(Math.random() * 4).toFixed(1)}s;
    `;
    sf.appendChild(s);
  }
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.conversations)) {
        state = parsed;
      }
    }
  } catch (e) {
    console.warn("Gagal load history:", e);
  }
}

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) {
    console.warn("Gagal simpan history:", e);
  }
}

function getActiveConv() {
  return state.conversations.find((c) => c.id === state.activeId) || null;
}

function createConversation() {
  const conv = {
    id: crypto.randomUUID(),
    title: "Obrolan baru",
    messages: [],
    createdAt: Date.now(),
  };
  state.conversations.unshift(conv);
  state.activeId = conv.id;
  saveState();
  renderSidebar();
  renderConversation();
}

function deleteConversation(id) {
  state.conversations = state.conversations.filter((c) => c.id !== id);
  if (state.activeId === id) {
    state.activeId = state.conversations[0]?.id || null;
  }
  saveState();
  renderSidebar();
  renderConversation();
}

function setActiveConversation(id) {
  state.activeId = id;
  saveState();
  renderSidebar();
  renderConversation();
  closeMobileSidebar();
}

function deriveTitle(text) {
  const clean = (text || "").trim().replace(/\s+/g, " ");
  return clean.length > 38 ? clean.slice(0, 38) + "…" : clean || "Lampiran";
}

function renderSidebar() {
  const list = document.getElementById("convList");
  list.innerHTML = "";

  if (state.conversations.length === 0) {
    const empty = document.createElement("div");
    empty.style.color = "var(--dim)";
    empty.style.fontSize = "13px";
    empty.style.padding = "10px 12px";
    empty.textContent = "Belum ada obrolan.";
    list.appendChild(empty);
    return;
  }

  for (const conv of state.conversations) {
    const item = document.createElement("div");
    item.className = "conv-item" + (conv.id === state.activeId ? " active" : "");
    item.innerHTML = `
      <span class="conv-label">${escapeHtml(conv.title)}</span>
      <button class="conv-del" title="Hapus" aria-label="Hapus obrolan">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18M6 6l12 12"/></svg>
      </button>
    `;
    item.addEventListener("click", (e) => {
      if (e.target.closest(".conv-del")) return;
      setActiveConversation(conv.id);
    });
    item.querySelector(".conv-del").addEventListener("click", (e) => {
      e.stopPropagation();
      deleteConversation(conv.id);
    });
    list.appendChild(item);
  }
}

function renderConversation() {
  const conv = getActiveConv();
  const emptyState = document.getElementById("emptyState");
  const messagesEl = document.getElementById("messages");
  const titleEl = document.getElementById("convTitle");

  messagesEl.innerHTML = "";

  if (!conv || conv.messages.length === 0) {
    emptyState.style.display = "flex";
    titleEl.textContent = "Obrolan baru";
    return;
  }

  emptyState.style.display = "none";
  titleEl.textContent = conv.title;

  for (const msg of conv.messages) {
    messagesEl.appendChild(buildMessageEl(msg.role, msg.content, msg.attachments, msg.earthImage));
  }
  decorateCodeBlocks(messagesEl);
  scrollToBottom();
}

function buildMessageEl(role, content, attachments, earthImage) {
  const wrap = document.createElement("div");
  wrap.className = `msg ${role}`;

  const avatar = document.createElement("div");
  avatar.className = "msg-avatar";
  avatar.textContent = role === "user" ? "YOU" : "ZPM";

  const body = document.createElement("div");
  body.className = "msg-body";

  if (attachments && attachments.length > 0) {
    const attWrap = document.createElement("div");
    attWrap.className = "msg-attachments";
    for (const a of attachments) {
      if (a.kind === "image" && a.previewUrl) {
        const img = document.createElement("img");
        img.src = a.previewUrl;
        img.alt = a.name;
        attWrap.appendChild(img);
      } else {
        const chip = document.createElement("div");
        chip.className = "file-chip";
        chip.innerHTML = `📄 ${escapeHtml(a.name)}`;
        attWrap.appendChild(chip);
      }
    }
    body.appendChild(attWrap);
  }

  const bubble = document.createElement("div");
  bubble.className = "bubble";
  if (earthImage) {
    bubble.innerHTML = buildEarthCardHtml(earthImage);
  } else if (role === "assistant") {
    bubble.innerHTML = renderMarkdown(content);
  } else {
    bubble.textContent = content;
  }
  if (role === "assistant" || content || earthImage) body.appendChild(bubble);

  wrap.appendChild(avatar);
  wrap.appendChild(body);
  return wrap;
}

// Menarik keluar semua blok/inline LaTeX dari teks SEBELUM diproses oleh
// marked.js, lalu menggantinya dengan placeholder aman-markdown.
// Ini mencegah marked "memakan" backslash di depan \[ \] \( \) sehingga
// rumus seperti \begin{aligned}...\end{aligned} tidak lagi bocor sebagai teks mentah.
function extractMath(text) {
  const store = [];
  const stash = (expr, display) => {
    store.push({ expr, display });
    return `@@ZPMMATH${store.length - 1}@@`;
  };

  let out = text;
  // Blok: \[ ... \]
  out = out.replace(/\\\[([\s\S]+?)\\\]/g, (_, expr) => stash(expr, true));
  // Blok: $$ ... $$
  out = out.replace(/\$\$([\s\S]+?)\$\$/g, (_, expr) => stash(expr, true));
  // Inline: \( ... \)
  out = out.replace(/\\\(([\s\S]+?)\\\)/g, (_, expr) => stash(expr, false));

  return { text: out, store };
}

function renderMarkdown(text) {
  try {
    const { text: safeText, store } = extractMath(text);
    let html = marked.parse(safeText, { breaks: true });

    html = html.replace(/@@ZPMMATH(\d+)@@/g, (match, idxStr) => {
      const item = store[Number(idxStr)];
      if (!item) return match;
      if (typeof katex === "undefined") return escapeHtml(item.expr);
      try {
        return katex.renderToString(item.expr, {
          throwOnError: false,
          displayMode: item.display,
        });
      } catch (e) {
        return escapeHtml(item.expr);
      }
    });

    return html;
  } catch (e) {
    return escapeHtml(text);
  }
}

function formatEpicDate(dateStr) {
  if (!dateStr) return "-";
  // Format NASA: "YYYY-MM-DD HH:MM:SS" -> tampilkan lebih ramah
  const iso = dateStr.replace(" ", "T") + "Z";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return dateStr;
  return d.toLocaleString("id-ID", {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  }) + " UTC";
}

function buildEarthCardHtml(payload) {
  if (!payload || payload.ok === false) {
    const msg = (payload && payload.error) || "Gagal mengambil gambar Bumi dari NASA EPIC.";
    return `
      <div class="earth-card earth-card-error">
        <span class="earth-error-icon"></span>
        <div class="earth-error-text">${escapeHtml(msg)}</div>
      </div>
    `;
  }

  return `
    <div class="earth-card">
      <div class="earth-card-imgwrap">
        <img
          class="earth-card-img"
          src="${payload.image_url}"
          alt="${escapeHtml(payload.image_name || "Bumi dari NASA EPIC")}"
          loading="lazy"
          onerror="this.closest('.earth-card').classList.add('earth-card-broken'); this.alt='Gambar tidak dapat dimuat';"
        >
      </div>
      <div class="earth-card-info">
        <div class="earth-card-title">Bumi Hari Ini — NASA</div>
        <div class="earth-card-row"><span class="earth-card-label">Tanggal</span>${escapeHtml(formatEpicDate(payload.date))}</div>
        <div class="earth-card-row"><span class="earth-card-label">Nama gambar</span>${escapeHtml(payload.image_name || "-")}</div>
        <div class="earth-card-caption">${escapeHtml(payload.caption || "Tidak ada caption.")}</div>
      </div>
    </div>
  `;
}

function decorateCodeBlocks(container) {
  container.querySelectorAll("pre code").forEach((block) => {
    if (block.dataset.decorated) return;
    block.dataset.decorated = "1";

    hljs.highlightElement(block);

    const lang = (block.className.match(/language-(\w+)/) || [])[1] || "text";
    const pre = block.parentElement;
    const toolbar = document.createElement("div");
    toolbar.className = "code-toolbar";
    toolbar.innerHTML = `<span>${lang}</span><button class="copy-btn">Salin</button>`;
    toolbar.querySelector(".copy-btn").addEventListener("click", () => {
      navigator.clipboard.writeText(block.textContent).then(() => {
        const btn = toolbar.querySelector(".copy-btn");
        btn.textContent = "Tersalin!";
        setTimeout(() => (btn.textContent = "Salin"), 1500);
      });
    });
    pre.parentElement.insertBefore(toolbar, pre);
  });
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function scrollToBottom() {
  const scroll = document.getElementById("chatScroll");
  scroll.scrollTop = scroll.scrollHeight;
}

const IMAGE_EXTS = ["png", "jpg", "jpeg", "webp", "gif"];

function fileKind(file) {
  const ext = file.name.split(".").pop().toLowerCase();
  return IMAGE_EXTS.includes(ext) ? "image" : "text";
}

function addPendingFiles(fileList) {
  for (const file of Array.from(fileList)) {
    const kind = fileKind(file);
    const entry = { file, kind, previewUrl: null, id: crypto.randomUUID() };
    if (kind === "image") {
      entry.previewUrl = URL.createObjectURL(file);
    }
    pendingFiles.push(entry);
  }
  renderAttachmentPreview();
}

function removePendingFile(id) {
  pendingFiles = pendingFiles.filter((f) => f.id !== id);
  renderAttachmentPreview();
}

function renderAttachmentPreview() {
  const wrap = document.getElementById("attachmentPreview");
  wrap.innerHTML = "";
  for (const entry of pendingFiles) {
    const chip = document.createElement("div");
    chip.className = "attach-chip";
    if (entry.kind === "image") {
      chip.innerHTML = `<img src="${entry.previewUrl}" alt="">
        <span class="chip-name">${escapeHtml(entry.file.name)}</span>
        <button type="button" class="chip-remove">✕</button>`;
    } else {
      chip.innerHTML = `<span class="chip-icon">📄</span>
        <span class="chip-name">${escapeHtml(entry.file.name)}</span>
        <button type="button" class="chip-remove">✕</button>`;
    }
    chip.querySelector(".chip-remove").addEventListener("click", () => removePendingFile(entry.id));
    wrap.appendChild(chip);
  }
}

function clearPendingFiles() {
  pendingFiles = [];
  renderAttachmentPreview();
}

async function sendMessage(text) {
  // Pengaman utama: kalau AI masih memproses pesan sebelumnya, abaikan
  // permintaan kirim baru sama sekali (mencegah perintah bentrok & spam),
  // terlepas dari state UI (disabled dsb) yang mungkin belum sempat update.
  if (isSending) return;

  let conv = getActiveConv();
  if (!conv) {
    createConversation();
    conv = getActiveConv();
  }

  const filesToSend = pendingFiles.slice();
  clearPendingFiles();

  const attachmentsMeta = filesToSend.map((f) => ({
    kind: f.kind,
    name: f.file.name,
    previewUrl: f.kind === "image" ? f.previewUrl : null,
  }));

  const isFirstMessage = conv.messages.length === 0;
  conv.messages.push({ role: "user", content: text, attachments: attachmentsMeta });
  if (isFirstMessage) {
    conv.title = deriveTitle(text || filesToSend[0]?.file.name);
  }
  saveState();
  renderSidebar();
  renderConversation();

  const messagesEl = document.getElementById("messages");
  const assistantWrap = buildMessageEl("assistant", "");
  const bubble = assistantWrap.querySelector(".bubble");
  bubble.innerHTML = `
    <div class="thinking-wrap">
      <div class="typing-dots"><span></span><span></span><span></span></div>
      <span class="thinking-status">ZUPIUM sedang berpikir...</span>
    </div>
  `;
  messagesEl.appendChild(assistantWrap);
  scrollToBottom();

  // Setelah beberapa detik, tampilkan label supaya user tahu ini masih
  // proses normal, bukan macet/error, kalau modelnya kebetulan lambat.
  const thinkingStatusEl = bubble.querySelector(".thinking-status");
  let thinkingSeconds = 0;
  thinkingTimerId = setInterval(() => {
    thinkingSeconds += 1;
    if (!thinkingStatusEl) return;
    if (thinkingSeconds >= 4) {
      thinkingStatusEl.textContent = `Masih memproses jawaban... (${thinkingSeconds}d)`;
      thinkingStatusEl.classList.add("visible");
    }
  }, 1000);

  activeAbortController = new AbortController();
  setSending(true);

  let fullText = "";
  let earthImagePayload = null;
  try {
    const formData = new FormData();
    const historyForServer = conv.messages.slice(0, -1).map((m) => ({
      role: m.role,
      content: m.content,
    }));
    formData.append("payload", JSON.stringify({ message: text, history: historyForServer }));
    for (const f of filesToSend) {
      formData.append("files", f.file, f.file.name);
    }

    const resp = await fetch("/api/chat", {
      method: "POST",
      body: formData,
      signal: activeAbortController.signal,
    });

    if (!resp.ok || !resp.body) {
      const errData = await resp.json().catch(() => ({}));
      throw new Error(errData.error || `Server error: ${resp.status}`);
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const parts = buffer.split("\n\n");
      buffer = parts.pop();

      for (const part of parts) {
        const line = part.trim();
        if (!line.startsWith("data:")) continue;
        const jsonStr = line.slice(5).trim();
        if (!jsonStr) continue;

        let payload;
        try {
          payload = JSON.parse(jsonStr);
        } catch {
          continue;
        }

        if (payload.error) throw new Error(payload.error);

        if (payload.earth_image) {
          earthImagePayload = payload.earth_image;
          bubble.innerHTML = buildEarthCardHtml(earthImagePayload);
          scrollToBottom();
          continue;
        }

        if (payload.token) {
          fullText += payload.token;
          bubble.innerHTML = renderMarkdown(fullText);
          decorateCodeBlocks(messagesEl);
          scrollToBottom();
        }
      }
    }

    if (earthImagePayload) {
      fullText = earthImagePayload.ok
        ? `Gambar Bumi terbaru dari NASA EPIC (${earthImagePayload.date_only || "-"}).`
        : `⚠️ ${earthImagePayload.error || "Gagal mengambil gambar Bumi."}`;
    } else if (!fullText.trim()) {
      fullText = "_Tidak ada respons dari model._";
      bubble.innerHTML = renderMarkdown(fullText);
    }
  } catch (err) {
    if (err.name === "AbortError") {
      // Dihentikan manual oleh user lewat tombol stop, bukan error server
      fullText = fullText.trim()
        ? fullText + "\n\n_(Dihentikan oleh pengguna)_"
        : "_Permintaan dihentikan sebelum ZUPIUM selesai menjawab._";
    } else {
      fullText = `⚠️ Terjadi kesalahan: ${err.message || "tidak bisa menghubungi server."}`;
    }
    bubble.innerHTML = renderMarkdown(fullText);
  } finally {
    clearInterval(thinkingTimerId);
    thinkingTimerId = null;
    activeAbortController = null;
    conv.messages.push({ role: "assistant", content: fullText, earthImage: earthImagePayload });
    saveState();
    setSending(false);
  }
}

// Menghentikan permintaan yang sedang berjalan (dipicu klik tombol "stop")
function stopGenerating() {
  if (activeAbortController) {
    activeAbortController.abort();
  }
}

function setSending(sending) {
  isSending = sending;
  const sendBtn = document.getElementById("sendBtn");
  const input = document.getElementById("messageInput");
  const hint = document.getElementById("composerHint");

  // Yang dikunci hanya input teks, supaya user tidak bisa mengetik/kirim perintah baru yang bentrok dengan yang sedang diproses
  input.disabled = sending;
  sendBtn.classList.toggle("is-sending", sending);
  sendBtn.setAttribute("aria-label", sending ? "Hentikan respons ZUPIUM" : "Kirim pesan");

  const attachBtn = document.getElementById("attachBtn");
  if (attachBtn) attachBtn.disabled = sending;

  document.querySelectorAll(".sugg-card").forEach((card) => {
    card.style.pointerEvents = sending ? "none" : "";
    card.style.opacity = sending ? "0.5" : "";
  });

  if (hint) {
    hint.textContent = sending
      ? "ZUPIUM sedang memproses jawaban... klik tombol untuk menghentikan."
      : "ZUPIUM bisa saja salah. Periksa kembali informasi yang diberikan ZUPIUM";
    hint.classList.toggle("is-thinking", sending);
  }
}

function openMobileSidebar() {
  document.getElementById("sidebar").classList.add("open");
}
function closeMobileSidebar() {
  document.getElementById("sidebar").classList.remove("open");
}

function autoGrowTextarea(el) {
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 140) + "px";
}

function init() {
  const titleEl = document.querySelector('.welcome-title');
  if (titleEl) {
    const text = titleEl.textContent.trim();
    titleEl.textContent = '';
    const totalDuration = 1000; // 1 detik total ketik
    const chars = Array.from(text);
    const stepDelay = totalDuration / chars.length;

    chars.forEach((char, index) => {
      setTimeout(() => {
        const span = document.createElement('span');
        span.className = 'char';
        span.textContent = char;
        titleEl.appendChild(span);
      }, index * stepDelay);
    });

    // Matikan caret blink secara permanen setelah animasi intro selesai,
    // supaya tidak menyala lagi saat empty-state ditampilkan ulang
    // (misalnya setelah klik "+ Obrolan baru").
    const caretBlinkDuration = 300 * 4; // harus sama dengan CSS title-blink
    setTimeout(() => {
      titleEl.classList.add('intro-done');
    }, totalDuration + caretBlinkDuration + 100);
  }

  initStarfield();
  loadState();

  if (state.conversations.length === 0) {
    createConversation();
  } else if (!state.activeId) {
    state.activeId = state.conversations[0].id;
  }

  renderSidebar();
  renderConversation();

  document.getElementById("newChatBtn").addEventListener("click", () => {
    createConversation();
    closeMobileSidebar();
  });

  document.getElementById("clearChatBtn").addEventListener("click", () => {
    const conv = getActiveConv();
    if (!conv) return;
    if (confirm("Hapus semua pesan di obrolan ini?")) {
      conv.messages = [];
      conv.title = "Obrolan baru";
      saveState();
      renderSidebar();
      renderConversation();
    }
  });

  document.getElementById("openSidebarBtn").addEventListener("click", openMobileSidebar);
  document.getElementById("closeSidebarBtn").addEventListener("click", closeMobileSidebar);
  document.getElementById("sidebarOverlay").addEventListener("click", closeMobileSidebar);

  const form = document.getElementById("composerForm");
  const input = document.getElementById("messageInput");

  input.addEventListener("input", () => autoGrowTextarea(input));
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      form.requestSubmit();
    }
  });

  form.addEventListener("submit", (e) => {
    e.preventDefault();

    // Tombol kirim berfungsi ganda: kalau AI sedang memproses, klik/enter
    // di sini artinya "hentikan", bukan kirim pesan baru. Ini mencegah
    // perintah baru bentrok dengan yang masih berjalan.
    if (isSending) {
      stopGenerating();
      return;
    }

    const text = input.value.trim();
    if (!text && pendingFiles.length === 0) return;
    input.value = "";
    autoGrowTextarea(input);
    sendMessage(text);
  });

  document.querySelectorAll(".sugg-card").forEach((card) => {
    card.addEventListener("click", () => {
      if (isSending) return; // anti-spam: abaikan klik saran saat AI masih memproses
      const prompt = card.dataset.prompt;
      input.value = prompt;
      form.requestSubmit();
    });
  });

  const attachBtn = document.getElementById("attachBtn");
  const attachMenu = document.getElementById("attachMenu");
  const imageInput = document.getElementById("imageInput");
  const fileInput = document.getElementById("fileInput");

  attachBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    attachMenu.classList.toggle("open");
    attachBtn.classList.toggle("open");
  });

  document.addEventListener("click", (e) => {
    if (!attachMenu.contains(e.target) && e.target !== attachBtn) {
      attachMenu.classList.remove("open");
      attachBtn.classList.remove("open");
    }
  });

  attachMenu.querySelectorAll(".attach-menu-item").forEach((btn) => {
    btn.addEventListener("click", () => {
      attachMenu.classList.remove("open");
      attachBtn.classList.remove("open");
      if (btn.dataset.accept === "image") {
        imageInput.click();
      } else {
        fileInput.click();
      }
    });
  });

  imageInput.addEventListener("change", () => {
    if (imageInput.files.length) addPendingFiles(imageInput.files);
    imageInput.value = "";
  });
  fileInput.addEventListener("change", () => {
    if (fileInput.files.length) addPendingFiles(fileInput.files);
    fileInput.value = "";
  });
}

document.addEventListener("DOMContentLoaded", init);
