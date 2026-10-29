const $ = (sel) => document.querySelector(sel);

const CLASS_NAMES = [
  "Bukan Kehadiran Kognitif", "Pemantik Diskusi",
  "Eksplorasi", "Integrasi", "Resolusi",
];

// Ringkasan rubrik `prompts/system_few_shot.md` (definisi + pembeda), dipadatkan.
const CLASS_DEFS = [
  "Sapaan, terima kasih, logistik, dukungan sosial. Tanpa isi materi.",
  "Bertanya atau mengaku bingung. Ada percikan inkuiri, belum menyumbang jawaban.",
  "Berbagi info, definisi, contoh, atau opini beralasan. Belum menyintesis.",
  "Menyintesis, merefleksi, atau menyusun pembuktian langkah demi langkah.",
  "Simpulan final yang menutup masalah; solusi dipertahankan atau diuji.",
];

const state = {
  labels: ["C0", "C1", "C2", "C3", "C4"],
  names: CLASS_NAMES,
  sessions: [],
  active: null,
  rows: [],
  busy: false,
  poll: null,
  view: "chat",
  collapsed: false,
  bulk: { on: false, ids: new Set() },
};

const thread = $("#thread");
const threadInner = $("#thread-inner");
const chatEmpty = $("#chat-empty");
const chatView = $("#view-chat");
const input = $("#chat-input");
const sendBtn = $("#chat-send");
const thinkingSel = $("#chat-thinking");

/** Tombol kirim samar selama kotak kosong, putih penuh begitu ada 1 karakter. */
function syncSend() {
  sendBtn.classList.toggle("is-off", input.value.length === 0);
}

/* ---------------- api ---------------- */

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: opts.body ? { "Content-Type": "application/json" } : undefined,
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);
  return data;
}

/* ---------------- boot ---------------- */

async function boot() {
  renderLegend();
  renderChips();
  setCollapsed(localStorage.getItem("sidebarCollapsed") === "1", false);
  try {
    const h = await api("/api/health");
    state.labels = h.labels || state.labels;
    state.names = h.class_names || CLASS_NAMES;
    renderLegend();
  } catch {
    // biarkan nilai default lokal; daftar sesi tetap dicoba di bawah
  }
  await loadSessions();
  await restoreUi();
}

/* Posisi terakhir (view + sesi) disimpan supaya reload tidak melompat ke halaman lain. */
const UI_KEY = "uiState";

function saveUiState() {
  try {
    localStorage.setItem(UI_KEY, JSON.stringify({ view: state.view, sessionId: state.active }));
  } catch {}   // mode privat / kuota penuh: abaikan, hanya kehilangan posisi
}

async function restoreUi() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(UI_KEY) || "null"); } catch { saved = null; }
  const id = saved?.sessionId && state.sessions.some((s) => s.id === saved.sessionId)
    ? saved.sessionId : null;
  if (id) { await openSession(id); return; }
  if (saved?.view === "batch") {
    newBatchView();
    switchView("batch");
    return;
  }
  newSession();
}

function renderLegend() {
  $("#legend").innerHTML = state.labels.map((l, i) => `
    <li>
      <div class="legend-head"><code>${l}</code><span>${state.names[i] || ""}</span></div>
      <p>${CLASS_DEFS[i] || ""}</p>
    </li>`).join("");
}

function renderChips() {
  $("#chat-chips").innerHTML = state.labels
    .map((l, i) => `<span class="chip">${l} · ${CLASS_NAMES[i] || ""}</span>`)
    .join("");
}

/* ---------------- sessions ---------------- */

async function loadSessions(openLatest = false) {
  try {
    state.sessions = (await api("/api/sessions")).sessions;
  } catch {
    state.sessions = [];
  }
  renderSessionList();
  if (openLatest) {
    if (state.sessions.length) await openSession(state.sessions[0].id);
    else showEmpty();
  }
}
function fmtWhen(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay
    ? d.toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString("id-ID", { day: "numeric", month: "short" });
}

/* ---------------- daftar sesi ---------------- */

/** Kelompok tanggal gaya chat.deepseek.com; dipakai untuk judul grup. */
function dateGroup(iso) {
  if (!iso) return "Lebih lama";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "Lebih lama";
  const now = new Date();
  const hariIni = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const hari = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const beda = Math.round((hariIni - hari) / 86400000);
  if (beda <= 0) return "Hari ini";
  if (beda === 1) return "Kemarin";
  if (beda <= 7) return "7 hari terakhir";
  if (beda <= 30) return "30 hari terakhir";
  return "Lebih lama";
}

const GROUP_ORDER = ["Pinned", "Hari ini", "Kemarin", "7 hari terakhir",
                     "30 hari terakhir", "Lebih lama"];

const PIN_SVG = '<svg class="pin-ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 17v5"/><path d="M9 3h6l-1 6 4 4v2H6v-2l4-4z"/></svg>';
const KEBAB_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.6" fill="currentColor" stroke="none"/></svg>';

function sessionItemHtml(s) {
  const isBatch = s.kind === "batch";
  const picked = state.bulk.on && state.bulk.ids.has(s.id);

  // Mode pilih banyak: baris jadi judul + bulatan centang saja (gaya chat.deepseek.com)
  if (state.bulk.on) {
    return `
    <div class="session-item bulk${picked ? " picked" : ""}" data-id="${s.id}">
      <span class="sel-box${picked ? " on" : ""}" aria-hidden="true">
        <svg viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5"/></svg>
      </span>
      <span class="session-title"></span>
    </div>`;
  }

  const sub = isBatch
    ? [`CSV, ${s.n_rows ?? 0} baris`,
       s.accuracy != null ? `${(s.accuracy * 100).toFixed(1)}%` : null,
       s.status && s.status !== "done" ? s.status : null].filter(Boolean).join(" · ")
    : `${s.n_messages} pesan`;
  return `
    <div class="session-item${s.id === state.active ? " active" : ""}" data-id="${s.id}">
      <button class="session-open" data-act="open">
        <span class="session-line">
          ${s.pinned ? PIN_SVG : ""}${isBatch ? '<span class="kind">CSV</span>' : ""}
          <span class="session-title"></span>
        </span>
        <small>${sub} · ${fmtWhen(s.updated_at)}</small>
      </button>
      <button class="kebab" data-act="menu" title="Opsi sesi" aria-label="Opsi sesi">${KEBAB_SVG}</button>
    </div>`;
}

function renderSessionList() {
  const list = $("#session-list");
  // Jangan sentuh DOM selama input rename hidup: fokus akan hilang dan blur
  // memicu finish() dua kali.
  if (list.querySelector(".session-rename")) return;
  if (!state.sessions.length) {
    list.innerHTML = `<p class="session-empty">Belum ada sesi.</p>`;
    return;
  }
  const groups = new Map();
  for (const s of state.sessions) {
    const key = s.pinned ? "Pinned" : dateGroup(s.updated_at);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }
  const keys = [...groups.keys()]
    .sort((a, b) => GROUP_ORDER.indexOf(a) - GROUP_ORDER.indexOf(b));
  list.innerHTML = keys.map((key) =>
    `<p class="session-group">${key}</p>` + groups.get(key).map(sessionItemHtml).join("")
  ).join("");

  // judul diisi via textContent (judul berasal dari teks user, jangan innerHTML)
  state.sessions.forEach((s) => {
    const el = list.querySelector(`.session-item[data-id="${s.id}"] .session-title`);
    if (el) el.textContent = s.title;
  });
}

let openSeq = 0;

async function openSession(id) {
  const seq = ++openSeq;
  stopPoll();
  let data;
  try {
    data = await api(`/api/sessions/${id}`);
  } catch {
    await loadSessions();
    return;
  }
  if (seq !== openSeq) return;      // klik lain sudah menang; jangan timpa tampilan
  state.active = id;
  renderSessionList();
  if ((data.kind || "chat") === "batch") {
    switchView("batch");
    renderBatchSession(data);
  } else {
    switchView("chat");
    renderThread(data.messages || []);
  }
}

/** Tampilkan sesi hasil CSV: tabel + metrik + unduhan; lanjut polling kalau masih jalan. */
function renderBatchSession(data) {
  state.rows = (data.records || []).slice().sort((a, b) => a.idx - b.idx);

  $("#result-panel").classList.remove("hidden");
  $("#result-session").textContent = data.title || "";
  $("#progress-wrap").classList.remove("hidden");
  $("#metrics").innerHTML = "";
  $("#result-body").innerHTML = "";
  $("#only-wrong").checked = false;
  $("#table-tools").classList.toggle("hidden", !state.rows.some((r) => r.gold));
  state.rows.forEach(appendRow);
  setProgress(data.records?.length || 0, data.total || 0);

  if (data.status === "queued" || data.status === "running") {
    startPoll(data.id, data.job_id, state.rows.length);
    return;
  }
  finishJob({ metrics: data.metrics, usage: data.usage, elapsed_s: data.elapsed_s,
              n_parse_fail: data.n_parse_fail, total: data.total, status: data.status,
              error: data.error, artifacts: data.artifacts });
}

/* ---------------- batch polling ---------------- */

function stopPoll() {
  if (state.poll?.timer) clearTimeout(state.poll.timer);
  state.poll = null;
}

function startPoll(sessionId, jobId, offset) {
  stopPoll();
  state.poll = { sessionId, jobId, offset, timer: null };
  tick();
}

async function tick() {
  const p = state.poll;
  if (!p) return;
  try {
    const res = await fetch(`/api/jobs/${p.jobId}?offset=${p.offset}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);
    if (state.poll !== p) return;          // user pindah sesi: hentikan render

    for (const rec of data.records) {
      p.offset += 1;
      state.rows.push(rec);
      appendRow(rec);
    }
    setProgress(data.done, data.total);
    syncWrong();

    if (data.status === "done" || data.status === "error") {
      finishJob(data);
      stopPoll();
      patchSession(p.sessionId, { status: data.status,
                                  accuracy: data.metrics?.accuracy ?? null });
      return;
    }
    p.timer = setTimeout(tick, 900);
  } catch (err) {
    $("#metrics").innerHTML =
      `<div class="metric"><span>error</span><strong>polling gagal</strong></div>`;
    $("#batch-start").disabled = false;
    stopPoll();
    console.error(err);
  }
}

/** Patch satu baris sesi di list tanpa refetch (pola `applyConversationUpdate` llama.cpp). */
function patchSession(id, res) {
  const s = state.sessions.find((x) => x.id === id);
  if (!s) return;
  if (res?.title) s.title = res.title;
  if (res?.n_messages != null) s.n_messages = res.n_messages;
  if (res?.n_rows != null) s.n_rows = res.n_rows;
  if (res?.status) s.status = res.status;
  if (res?.accuracy !== undefined) s.accuracy = res.accuracy;
  s.updated_at = new Date().toISOString();
  // pesan/hasil terbaru -> sesi naik ke atas
  state.sessions = [s, ...state.sessions.filter((x) => x.id !== id)];
  renderSessionList();
}

/** Buka komposer kosong. Sesi di server baru dibuat saat pesan pertama dikirim,
    jadi "+" yang ditekan berulang tidak meninggalkan sesi kosong di sidebar. */
function newSession() {
  stopPoll();
  state.active = null;
  renderSessionList();
  switchView("chat");
  renderThread([]);
  input.focus();
}

async function createSession() {
  const s = await api("/api/sessions", { method: "POST", body: JSON.stringify({}) });
  state.sessions.unshift({ id: s.id, kind: "chat", title: s.title,
                           updated_at: new Date().toISOString(), n_messages: 0 });
  state.active = s.id;
  renderSessionList();
  return s.id;
}

async function renameSession(id, item) {
  const current = state.sessions.find((s) => s.id === id);
  if (!current) return;
  const titleEl = item.querySelector(".session-title");
  if (!titleEl) return;              // sudah dalam mode rename
  const backup = current.title;
  const field = document.createElement("input");
  field.className = "session-rename";
  field.value = backup;
  field.maxLength = 80;
  titleEl.replaceWith(field);
  field.focus();
  field.select();

  let closed = false;
  const finish = async (commit) => {
    if (closed) return;
    closed = true;
    const title = field.value.trim();
    if (commit && title && title !== backup) {
      try {
        const res = await api(`/api/sessions/${id}`,
          { method: "PATCH", body: JSON.stringify({ title }) });
        current.title = res.title;
      } catch (err) {
        alert(`Gagal ganti nama: ${err.message}`);
        current.title = backup;
      }
    }
    field.remove();
    renderSessionList();
  };

  field.addEventListener("keydown", (e) => {
    if (e.key === "Enter") finish(true);
    if (e.key === "Escape") finish(false);
  });
  field.addEventListener("blur", () => finish(true));
}

async function deleteSession(id, silent = false) {
  const s = state.sessions.find((x) => x.id === id);
  if (!s) return;
  const at = state.sessions.findIndex((x) => x.id === id);

  // Hapus optimistis: baris hilang sekarang, DELETE sungguhan 8 detik kemudian.
  // Selama jendela itu pengguna bisa membatalkan tanpa kehilangan apa pun.
  state.sessions = state.sessions.filter((x) => x.id !== id);
  if (state.active === id) {
    state.active = null;
    stopPoll();
    $("#result-panel").classList.add("hidden");
    $("#progress-wrap").classList.add("hidden");
    showEmpty();
    saveUiState();
  }
  renderSessionList();
  if (silent) return;

  let undone = false;
  const timer = setTimeout(async () => {
    if (undone) return;
    try {
      await api(`/api/sessions/${id}`, { method: "DELETE" });
    } catch (err) {
      toast(`Gagal menghapus: ${err.message}`);
    }
  }, 8000);

  toast(`Sesi "${s.title}" dihapus`, {
    label: "Batalkan",
    onAction: () => {
      undone = true;
      clearTimeout(timer);
      state.sessions.splice(Math.min(at, state.sessions.length), 0, s);
      renderSessionList();
    },
  });
}

$("#session-list").addEventListener("click", (e) => {
  const item = e.target.closest(".session-item");
  if (!item) return;
  const id = item.dataset.id;
  const act = e.target.closest("[data-act]")?.dataset.act;
  const s = state.sessions.find((x) => x.id === id);
  if (!s) return;
  if (act === "menu") { openCtx(e.target.closest("[data-act]"), s.id); return; }
  if (state.bulk.on) { togglePick(id); return; }
  if (act === "open" && id !== state.active) openSession(id);
});

$("#new-session").addEventListener("click", () => newSession());
$("#rail-new").addEventListener("click", () => newSession());

$("#bulk-bar").addEventListener("click", async (e) => {
  const act = e.target.closest("[data-bulk]")?.dataset.bulk;
  if (!act) return;
  const ids = [...state.bulk.ids];
  if (!ids.length) return;
  if (act === "pin") {
    for (const id of ids) {
      const s = state.sessions.find((x) => x.id === id);
      if (s && !s.pinned) await togglePin(s, true);
    }
  } else if (act === "delete") {
    if (!confirm(`Hapus ${ids.length} sesi terpilih? Tindakan ini tidak bisa dibatalkan.`)) return;
    for (const id of ids) await deleteSession(id, true);
  }
  exitBulk();
});

$("#bulk-close").addEventListener("click", () => exitBulk());

/* ---------------- thread rendering ---------------- */

function showEmpty() {
  threadInner.innerHTML = "";
  threadInner.classList.add("hidden");
  chatEmpty.classList.remove("hidden");
  chatView.classList.add("is-empty");   // komposer pindah ke tengah layar
}

function showThread() {
  chatEmpty.classList.add("hidden");
  threadInner.classList.remove("hidden");
  chatView.classList.remove("is-empty");  // ada pesan -> komposer turun ke bawah
}

function renderThread(messages) {
  threadInner.innerHTML = "";
  if (!messages.length) {
    showEmpty();
    return;
  }
  showThread();
  messages.forEach((m) => {
    if (m.role === "user") appendUser(m.text);
    else appendAssistant(m, m.thinking || "");
  });
  thread.scrollTop = thread.scrollHeight;
}

function appendUser(text) {
  const wrap = document.createElement("div");
  wrap.className = "msg user";
  wrap.innerHTML = `<div class="avatar">YOU</div>
    <div class="body"><div class="who">Postingan</div><div class="text"></div></div>`;
  wrap.querySelector(".text").textContent = text;
  threadInner.appendChild(wrap);
  showThread();
  thread.scrollTop = thread.scrollHeight;
  return wrap;
}

const THINK_CHEV = '<svg class="chev-ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';
const THINK_IC = '<svg class="think-ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v2M5 6l1.5 1.5M19 6l-1.5 1.5"/><path d="M9 17h6M10 20h4"/><path d="M8.5 13.5a4.5 4.5 0 1 1 7 0c-.6.8-1 1.4-1 2.5h-5c0-1.1-.4-1.7-1-2.5z"/></svg>';

function cardHtml(rec, thinkText) {
  const isFail = !state.labels.includes(rec.pred);
  const idx = state.labels.indexOf(rec.pred);
  const cls = isFail ? "FAIL" : rec.pred;
  const thinkLabel = rec.latency_ms
    ? `Proses berpikir · ${(rec.latency_ms / 1000).toFixed(1)}s`
    : "Proses berpikir";
  return `
    <div class="card-head">
      <span class="badge ${cls}">${rec.pred}</span>
      <span class="class-name">${isFail ? "tidak terparse" : state.names[idx] || ""}</span>
    </div>
    ${thinkText ? `<details class="think"><summary>${THINK_IC}${thinkLabel}${THINK_CHEV}</summary><div class="think-body"></div></details>` : ""}
    <div class="reason"></div>`;
}

function fillCard(card, rec, thinkText) {
  card.querySelector(".reason").textContent =
    rec.reason || rec.error || "(model tidak memberi alasan)";
  const body = card.querySelector(".think-body");
  if (body) body.textContent = thinkText;
}

function assistantShell() {
  const wrap = document.createElement("div");
  wrap.className = "msg assistant";
  wrap.innerHTML = `<div class="avatar">AI</div>
    <div class="body"><div class="who">Klasifikator CoI</div>
      <div class="card">
        <details class="think hidden"><summary>${THINK_IC}Proses berpikir${THINK_CHEV}</summary><div class="think-body"></div></details>
        <div class="pending"><span class="pulse"></span><span class="pending-text">menganalisis…</span></div>
      </div>
    </div>`;
  threadInner.appendChild(wrap);
  showThread();
  thread.scrollTop = thread.scrollHeight;
  return wrap;
}

function appendAssistant(rec, thinkText) {
  const shell = assistantShell();
  const card = shell.querySelector(".card");
  card.innerHTML = cardHtml(rec, thinkText);
  fillCard(card, rec, thinkText);
  thread.scrollTop = thread.scrollHeight;
  return shell;
}

/* ---------------- chat ---------------- */

async function persist(id, msg) {
  try {
    return await api(`/api/sessions/${id}/messages`,
      { method: "POST", body: JSON.stringify(msg) });
  } catch (err) {
    console.warn("gagal simpan pesan:", err.message);
    return null;
  }
}

async function sendChat(ev) {
  ev.preventDefault();
  const text = input.value.trim();
  if (!text || state.busy) return;

  state.busy = true;
  sendBtn.disabled = true;
  input.value = "";
  input.style.height = "auto";
  syncSend();
  let shell = null;

  try {
    // Sesi aktif bisa berupa hasil CSV (tidak menerima pesan chat) -> buat sesi chat baru.
    const activeItem = state.sessions.find((s) => s.id === state.active);
    const sessionId = (!activeItem || activeItem.kind === "batch")
      ? await createSession() : state.active;

    const saved = await persist(sessionId, { role: "user", text });
    patchSession(sessionId, saved);
    appendUser(text);

    const shellEl = assistantShell();
    shell = shellEl;
    const pending = shellEl.querySelector(".pending-text");
    const card = shellEl.querySelector(".card");
    const liveThink = shellEl.querySelector(".think");
    const liveBody = shellEl.querySelector(".think-body");
    let reasoning = "";
    let raf = 0;
    // ~2500 delta per sampel: tulis DOM sekali per frame, bukan per token.
    const repaint = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        liveThink.classList.remove("hidden");
        liveBody.textContent = reasoning.slice(-4000);
        liveBody.scrollTop = liveBody.scrollHeight;
        pending.textContent = "berpikir…";
      });
    };

    const res = await fetch("/api/classify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, thinking: thinkingSel.value || null }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let finished = false;
    while (!finished) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const parts = buf.split("\n\n");
      buf = parts.pop() || "";
      for (const part of parts) {
        const evLine = part.match(/^event: (.+)$/m);
        const dataLine = part.match(/^data: (.+)$/m);
        if (!evLine || !dataLine) continue;
        const ev = evLine[1].trim();
        const data = JSON.parse(dataLine[1]);
        if (ev === "reasoning" || ev === "content") {
          reasoning += data.delta || "";
          repaint();
        } else if (ev === "result") {
          card.innerHTML = cardHtml(data, reasoning);
          fillCard(card, data, reasoning);
          finished = true;
          await persist(sessionId, {
            role: "assistant", pred: data.pred, reason: data.reason,
            thinking: reasoning.slice(0, 8000), latency_ms: data.latency_ms,
            finish: data.finish, budget: data.budget,
          }).then((saved) => patchSession(sessionId, saved));
        } else if (ev === "error") {
          throw new Error(data.message);
        }
      }
    }
  } catch (err) {
    const msg = String(err?.message || err);
    const card = shell?.querySelector(".card");
    if (card) {
      card.innerHTML = `<div class="card-head"><span class="badge FAIL">ERROR</span></div>
        <div class="reason"></div>`;
      card.querySelector(".reason").textContent = msg;
    } else {
      // Gagal sebelum kartu dibuat (mis. sesi gagal dibuat). Jangan diam:
      // teks dikembalikan ke kotak dan kegagalan diberitahukan.
      input.value = text;
      input.style.height = "auto";
      input.style.height = Math.min(input.scrollHeight, 240) + "px";
      syncSend();
      toast(`Gagal mengirim: ${msg}`);
    }
  } finally {
    state.busy = false;
    sendBtn.disabled = false;
    input.focus();
    thread.scrollTop = thread.scrollHeight;
  }
}

$("#composer").addEventListener("submit", sendChat);
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) sendChat(e);
});
input.addEventListener("input", () => {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 240) + "px";
  syncSend();
});
syncSend();

/* ---------------- view switch ---------------- */

function switchView(name) {
  document.querySelectorAll(".nav-item").forEach((b) =>
    b.classList.toggle("active", b.dataset.view === name));
  document.querySelectorAll(".view").forEach((v) =>
    v.classList.toggle("active", v.id === `view-${name}`));
  state.view = name;
  saveUiState();
}

/** Halaman Upload CSV kosong. Tanpa ini, isi job terakhir masih menempel di
    panel hasil saat menu sidebar ditekan (terlihat seperti membuka sesi lama). */
function newBatchView() {
  stopPoll();
  state.active = null;
  state.rows = [];
  pickedFile = null;
  $("#file-input").value = "";
  $("#drop-title").textContent = "Letakkan CSV di sini atau klik";
  $("#drop-sub").textContent = "maks 1000 baris per run";
  $("#dropzone").classList.remove("over");
  $("#batch-start").disabled = true;
  $("#result-panel").classList.add("hidden");
  $("#progress-wrap").classList.add("hidden");
  $("#result-session").textContent = "";
  $("#metrics").innerHTML = "";
  $("#result-body").innerHTML = "";
  $("#table-tools").classList.add("hidden");
  $("#only-wrong").checked = false;
  $("#wrong-count").textContent = "";
  $("#wrong-pill").classList.remove("on");
  document.querySelectorAll(".downloads .ghost").forEach((a) => a.classList.add("disabled"));
  setProgress(0, 0);
  renderSessionList();
}

document.querySelectorAll(".nav-item").forEach((btn) => {
  btn.addEventListener("click", () => {
    if (btn.dataset.view === "batch") newBatchView();
    switchView(btn.dataset.view);
  });
});

/* ---------------- batch ---------------- */

let pickedFile = null;

$("#dropzone").addEventListener("click", () => $("#file-input").click());
$("#file-input").addEventListener("change", (e) => setFile(e.target.files[0]));
["dragover", "dragleave", "drop"].forEach((evt) => {
  $("#dropzone").addEventListener(evt, (e) => {
    e.preventDefault();
    $("#dropzone").classList.toggle("over", evt === "dragover");
    if (evt === "drop") setFile(e.dataTransfer.files[0]);
  });
});

function setFile(file) {
  if (!file) return;
  pickedFile = file;
  $("#drop-title").textContent = file.name;
  $("#drop-sub").textContent = `${(file.size / 1024).toFixed(1)} KB, siap diklasifikasi`;
  $("#batch-start").disabled = false;
}

$("#batch-start").addEventListener("click", async () => {
  if (!pickedFile) return;
  $("#batch-start").disabled = true;

  const fd = new FormData();
  fd.append("file", pickedFile);
  fd.append("thinking", $("#batch-thinking").value);

  try {
    const res = await fetch("/api/jobs", { method: "POST", body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);

    state.rows = [];
    state.active = data.session_id;
    saveUiState();
    $("#result-body").innerHTML = "";
    $("#metrics").innerHTML = "";
    $("#result-panel").classList.remove("hidden");
    $("#result-session").textContent = data.title || "Hasil CSV";
    $("#table-tools").classList.toggle("hidden", !data.has_gold);
    $("#progress-wrap").classList.remove("hidden");
    $("#only-wrong").checked = false;
    document.querySelectorAll(".downloads .ghost").forEach((a) => a.classList.add("disabled"));
    // hasil CSV langsung jadi sesi di sidebar
    state.sessions.unshift({ id: data.session_id, kind: "batch", title: data.title,
                             updated_at: new Date().toISOString(), n_messages: 0,
                             n_rows: data.total, status: "running" });
    renderSessionList();
    setProgress(0, data.total);
    startPoll(data.session_id, data.job_id, 0);
  } catch (err) {
    $("#result-panel").classList.remove("hidden");
    $("#metrics").innerHTML = `<div class="metric"><span>error</span><strong>gagal</strong></div>`;
    $("#result-body").innerHTML = `<tr><td colspan="5" class="reason">${err.message}</td></tr>`;
    $("#batch-start").disabled = false;
  }
});

function setProgress(done, total) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  $("#progress-label").textContent = `${done} / ${total}`;
  $("#progress-pct").textContent = `${pct}%`;
  $("#progress-bar").style.width = `${pct}%`;
}

function appendRow(rec) {
  if ($("#only-wrong").checked && rec.gold && rec.pred === rec.gold) return;
  const tr = document.createElement("tr");
  tr.innerHTML = `
    <td class="idx">${rec.idx}</td>
    <td class="pred">${rec.pred}</td>
    <td class="gold">${rec.gold || "-"}</td>
    <td class="reason"></td>
    <td class="idx">${(rec.latency_ms / 1000).toFixed(1)}s</td>`;
  tr.querySelector(".reason").textContent = rec.reason || rec.error || "";
  $("#result-body").appendChild(tr);
}

function rerenderRows() {
  $("#result-body").innerHTML = "";
  state.rows.forEach(appendRow);
  syncWrong();
}

/** Jumlah baris salah masuk ke label filter; pill menyala saat aktif. */
function syncWrong() {
  const n = state.rows.filter((r) => r.gold && r.pred !== r.gold).length;
  $("#wrong-count").textContent = n ? String(n) : "";
  $("#wrong-pill").classList.toggle("on", $("#only-wrong").checked);
}

$("#only-wrong").addEventListener("change", rerenderRows);

function finishJob(data) {
  $("#batch-start").disabled = false;
  // Job selesai: urutkan tabel per idx (saat berjalan, baris muncul sesuai urutan selesai).
  state.rows.sort((a, b) => a.idx - b.idx);
  rerenderRows();
  const m = data.metrics || {};
  const chips = [];
  if (m.n_gold) {
    chips.push(["akurasi", (m.accuracy * 100).toFixed(1) + "%"]);
    chips.push(["macro-F1", m.macro_f1.toFixed(4)]);
    chips.push(["weighted-F1", m.weighted_f1.toFixed(4)]);
  }
  chips.push(["sampel", data.total]);
  if (data.n_parse_fail) chips.push(["parse-fail", data.n_parse_fail]);
  if (data.elapsed_s) chips.push(["waktu", data.elapsed_s + "s"]);
  if (data.usage) chips.push(["estimasi biaya", "$" + data.usage.usd]);
  if (data.status === "error") chips.push(["status", "error"]);

  $("#metrics").innerHTML = chips
    .map(([k, v]) => `<div class="metric"><span>${k}</span><strong>${v}</strong></div>`)
    .join("");

  document.querySelectorAll(".downloads .ghost").forEach((a) => {
    const known = data.artifacts ? data.artifacts[a.dataset.kind] : data.status === "done";
    a.classList.toggle("disabled", !known);
    if (known) a.href = `/api/sessions/${state.active}/download/${a.dataset.kind}`;
  });
  if (data.status === "error") {
    $("#metrics").insertAdjacentHTML(
      "beforeend", `<div class="metric"><span>error</span><strong>${data.error || ""}</strong></div>`);
  }
}

/* ---------------- sidebar: ciutkan / buka ---------------- */

function setCollapsed(v, remember = true) {
  state.collapsed = !!v;
  $(".shell").classList.toggle("collapsed", state.collapsed);
  $("#rail").classList.toggle("hidden", !state.collapsed);
  if (remember) localStorage.setItem("sidebarCollapsed", state.collapsed ? "1" : "0");
}

$("#side-collapse").addEventListener("click", () => setCollapsed(true));
$("#rail-open").addEventListener("click", () => setCollapsed(false));
$("#side-search").addEventListener("click", () => openSearch());
$("#rail-search").addEventListener("click", () => openSearch());
// Logo = pulang ke beranda: buka obrolan baru kosong.
$("#rail-home").addEventListener("click", () => newSession());
$("#brand-home").addEventListener("click", () => newSession());

/* ---------------- util kecil ---------------- */

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function highlight(text, q) {
  const src = String(text ?? "");
  const i = src.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return escapeHtml(src);
  return escapeHtml(src.slice(0, i)) + "<mark>" + escapeHtml(src.slice(i, i + q.length))
    + "</mark>" + escapeHtml(src.slice(i + q.length));
}

function slug(text) {
  return (text || "sesi").toLowerCase().replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "").slice(0, 48) || "sesi";
}

function toast(msg, action = null) {
  let el = $("#toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast";
    el.className = "toast";
    document.body.appendChild(el);
  }
  el.textContent = "";
  const text = document.createElement("span");
  text.textContent = msg;
  el.append(text);
  if (action) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "toast-act";
    btn.textContent = action.label;
    btn.addEventListener("click", () => {
      clearTimeout(el._t);
      el.classList.remove("show");
      action.onAction();
    });
    el.append(btn);
  }
  el.classList.add("show");
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove("show"), action ? 8000 : 2000);
}

function download(filename, text, type = "application/json") {
  const blob = new Blob([text], { type: `${type};charset=utf-8` });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1500);
}

async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      throw new Error("clipboard API tidak tersedia");
    }
    toast("Disalin ke clipboard");
  } catch {
    // Cadangan untuk browser yang menolak clipboard API: textarea + execCommand.
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand?.("copy");
    ta.remove();
    if (ok) toast("Disalin ke clipboard");
    else alert("Browser menolak akses clipboard. Pakai Unduh JSON atau Unduh Markdown.");
  }
}

/* ---------------- bagikan / ekspor ---------------- */

async function exportEnvelope(id) {
  const d = await api(`/api/sessions/${id}`);
  return {
    app: "cognitive-classifier-web",
    schema: 1,
    exported_at: new Date().toISOString(),
    session: {
      id: d.id, title: d.title, kind: d.kind || "chat",
      created_at: d.created_at, updated_at: d.updated_at,
      pinned: !!d.pinned,
      n_rows: d.total ?? null, accuracy: d.accuracy ?? null, status: d.status ?? null,
      messages: d.messages || [],
    },
  };
}

function classNameOf(pred) {
  const i = state.labels.indexOf(pred);
  return i >= 0 ? state.names[i] : "";
}

function toMarkdown(env) {
  const s = env.session;
  const when = new Date(env.exported_at).toLocaleString("id-ID");
  if (s.kind === "batch") {
    return `# ${s.title}\n\n_Sesi CSV, diekspor ${when}_\n\n`
      + [`- Baris: ${s.n_rows ?? "-"}`,
         `- Akurasi: ${s.accuracy != null ? (s.accuracy * 100).toFixed(2) + "%" : "-"}`,
         `- Status: ${s.status || "-"}`].join("\n") + "\n";
  }
  let out = `# ${s.title}\n\n_${s.messages.length} pesan, diekspor ${when}_\n`;
  for (const m of s.messages) {
    if (m.role === "user") {
      out += `\n**Kamu**\n\n${m.text || ""}\n`;
      continue;
    }
    const meta = [m.pred, classNameOf(m.pred),
                  m.latency_ms ? `${(m.latency_ms / 1000).toFixed(1)}s` : null]
      .filter(Boolean).join(", ");
    out += `\n**Klasifikasi CoI**${meta ? ` (${meta})` : ""}\n\n${m.reason || ""}\n`;
    if (m.thinking) {
      out += `\n<details><summary>proses berpikir</summary>\n\n${m.thinking}\n\n</details>\n`;
    }
  }
  return out;
}

function toPlain(env) {
  const s = env.session;
  if (s.kind === "batch") return `${s.title}\nBaris: ${s.n_rows ?? "-"} · Status: ${s.status || "-"}`;
  return s.messages.map((m) => m.role === "user"
    ? `KAMU: ${m.text || ""}`
    : `AI${m.pred ? ` (${m.pred})` : ""}: ${m.reason || ""}`).join("\n\n");
}

/* ---------------- menu konteks sesi ---------------- */

const ctx = $("#ctx");
let ctxId = null;
let ctxItem = null;
let ctxAnchor = null;

const ICON = {
  rename: '<svg viewBox="0 0 24 24"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>',
  pin: '<svg viewBox="0 0 24 24"><path d="M12 17v5"/><path d="M9 3h6l-1 6 4 4v2H6v-2l4-4z"/></svg>',
  share: '<svg viewBox="0 0 24 24"><path d="M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7"/><path d="M12 16V3M8 7l4-4 4 4"/></svg>',
  multi: '<svg viewBox="0 0 24 24"><path d="M9 6h11M9 12h11M9 18h11"/><path d="M4 6l1 1 1-1M4 12l1 1 1-1M4 18l1 1 1-1"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg>',
};

function placeCtx(anchor) {
  ctx.classList.remove("hidden");
  const r = anchor.getBoundingClientRect();
  const w = ctx.offsetWidth || 200;
  const h = ctx.offsetHeight || 200;
  const left = Math.min(r.left, window.innerWidth - w - 12);
  const top = Math.min(r.bottom + 6, window.innerHeight - h - 12);
  ctx.style.left = `${Math.max(10, left)}px`;
  ctx.style.top = `${Math.max(10, top)}px`;
}

function openCtx(anchor, id) {
  ctxId = id;
  ctxAnchor = anchor;
  ctxItem = anchor.closest(".session-item");
  renderCtxMain();
}

function closeCtx() {
  ctx.classList.add("hidden");
  ctxId = null;
  ctxAnchor = null;
}

function renderCtxMain() {
  const s = state.sessions.find((x) => x.id === ctxId);
  if (!s) return closeCtx();
  ctx.innerHTML = `
    <button class="ctx-item" data-ctx="rename">${ICON.rename} Ganti nama</button>
    <button class="ctx-item" data-ctx="pin">${ICON.pin} ${s.pinned ? "Lepas pin" : "Pin"}</button>
    <button class="ctx-item" data-ctx="share">${ICON.share} Bagikan <span class="ctx-arrow">›</span></button>
    <button class="ctx-item" data-ctx="multi">${ICON.multi} Pilih banyak</button>
    <div class="ctx-sep"></div>
    <button class="ctx-item danger" data-ctx="delete">${ICON.trash} Hapus</button>`;
  if (ctxAnchor) placeCtx(ctxAnchor);
}

function renderCtxShare() {
  ctx.innerHTML = `
    <button class="ctx-item dim" data-ctx="back"><span class="ctx-arrow back">‹</span> Bagikan</button>
    <div class="ctx-sep"></div>
    <button class="ctx-item" data-ctx="dl-json">Unduh JSON</button>
    <button class="ctx-item" data-ctx="dl-md">Unduh Markdown</button>
    <div class="ctx-sep"></div>
    <button class="ctx-item" data-ctx="cp-text">Copy teks biasa</button>
    <button class="ctx-item" data-ctx="cp-md">Copy Markdown</button>
    <button class="ctx-item" data-ctx="cp-json">Copy JSON</button>`;
  if (ctxAnchor) placeCtx(ctxAnchor);
}

ctx.addEventListener("click", async (e) => {
  // Wajib: klik "Bagikan" mengganti isi #ctx, sehingga e.target tidak lagi
  // berada di dalam #ctx. Listener document di bawah akan menganggapnya klik
  // di luar dan langsung menutup menu (submenu cuma berkedip).
  e.stopPropagation();
  const act = e.target.closest("[data-ctx]")?.dataset.ctx;
  if (!act) return;
  if (act === "back") { renderCtxMain(); return; }
  if (act === "share") { renderCtxShare(); return; }
  const id = ctxId;
  const s = state.sessions.find((x) => x.id === id);
  closeCtx();
  if (!s) return;
  if (act === "rename") {
    return renameSession(s.id, ctxItem || document.querySelector(`.session-item[data-id="${s.id}"]`));
  }
  if (act === "pin") return togglePin(s);
  if (act === "multi") return enterBulk(s.id);
  if (act === "delete") return deleteSession(s.id);

  if (act === "dl-json" || act === "cp-json") {
    const env = await exportEnvelope(s.id);
    const json = JSON.stringify(env, null, 2);
    return act === "dl-json" ? download(`${slug(s.title)}.json`, json) : copyText(json);
  }
  const env = await exportEnvelope(s.id);
  if (act === "dl-md") return download(`${slug(s.title)}.md`, toMarkdown(env), "text/markdown");
  if (act === "cp-md") return copyText(toMarkdown(env));
  if (act === "cp-text") return copyText(toPlain(env));
});

document.addEventListener("click", (e) => {
  if (!e.target.closest("#ctx") && !e.target.closest("[data-act='menu']")) {
    closeCtx();
  }
});

/* ---------------- pin ---------------- */

async function togglePin(s, silent = false) {
  const next = !s.pinned;
  try {
    const res = await api(`/api/sessions/${s.id}`,
      { method: "PATCH", body: JSON.stringify({ pinned: next }) });
    s.pinned = !!res.pinned;
  } catch (err) {
    alert(`Gagal ${next ? "pin" : "lepas pin"}: ${err.message}`);
    return;
  }
  if (!silent) renderSessionList();
}

/* ---------------- pilih banyak ---------------- */

function syncBulk() {
  const on = state.bulk.on;
  $(".sidebar").classList.toggle("selecting", on);
  $("#bulk-head").classList.toggle("hidden", !on);
  $("#bulk-bar").classList.toggle("hidden", !on);
  $("#bulk-count").textContent = `${state.bulk.ids.size} obrolan dipilih`;
}

function enterBulk(id) {
  state.bulk = { on: true, ids: new Set(id ? [id] : []) };
  syncBulk();
  renderSessionList();
}

function exitBulk() {
  state.bulk = { on: false, ids: new Set() };
  syncBulk();
  renderSessionList();
}

function togglePick(id) {
  if (state.bulk.ids.has(id)) state.bulk.ids.delete(id);
  else state.bulk.ids.add(id);
  syncBulk();
  renderSessionList();
}

/* ---------------- pencarian sesi (Ctrl+K) ---------------- */

let searchTimer = null;

function openSearch() {
  $("#search-modal").classList.remove("hidden");
  const el = $("#search-input");
  el.value = "";
  el.focus();
  $("#search-results").innerHTML =
    `<p class="search-hint">Ketik minimal 2 huruf. Pencarian mencakup judul dan isi pesan.</p>`;
}

function closeSearch() {
  $("#search-modal").classList.add("hidden");
}

$("#search-input").addEventListener("input", (e) => {
  const q = e.target.value.trim();
  clearTimeout(searchTimer);
  if (q.length < 2) {
    $("#search-results").innerHTML = `<p class="search-hint">Ketik minimal 2 huruf.</p>`;
    return;
  }
  searchTimer = setTimeout(() => runSearch(q), 180);
});

async function runSearch(q) {
  const box = $("#search-results");
  box.innerHTML = `<p class="search-hint">Mencari…</p>`;
  let data;
  try {
    data = await api(`/api/sessions/search?q=${encodeURIComponent(q)}`);
  } catch (err) {
    box.innerHTML = `<p class="search-hint">Gagal mencari: ${escapeHtml(err.message)}</p>`;
    return;
  }
  if (!data.results.length) {
    box.innerHTML = `<p class="search-hint">Tidak ada hasil untuk "${escapeHtml(q)}".</p>`;
    return;
  }
  box.innerHTML = data.results.map((r) => `
    <button class="search-hit" data-id="${r.id}">
      <span class="search-hit-head">
        ${r.kind === "batch" ? '<span class="kind">CSV</span>' : ""}
        <span class="search-hit-title">${highlight(r.title, q)}</span>
        <span class="search-hit-when">${fmtWhen(r.updated_at)}</span>
      </span>
      ${r.hits.map((h) => `<span class="search-hit-line"><em>${
        h.role === "user" ? "kamu" : h.role === "title" ? "judul" : "AI"
      }</em> ${highlight(h.snippet, q)}</span>`).join("")}
    </button>`).join("");
}

$("#search-results").addEventListener("click", (e) => {
  const hit = e.target.closest(".search-hit");
  if (!hit) return;
  closeSearch();
  openSession(hit.dataset.id);
});

$("#search-modal").addEventListener("click", (e) => {
  if (e.target.id === "search-modal") closeSearch();
});

$("#search-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    const first = $("#search-results").querySelector(".search-hit");
    if (first) { closeSearch(); openSession(first.dataset.id); }
  }
});

/* ---------------- pintasan papan ketik ---------------- */

document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    if ($("#search-modal").classList.contains("hidden")) openSearch();
    else closeSearch();
  } else if (e.key === "Escape") {
    closeSearch();
    closeCtx();
    if (state.bulk.on) exitBulk();
  }
});

/* ---------------- popover menu (pengganti <select> native) ----------------
   Native <select> memunculkan daftar bawaan OS yang tidak bisa digaya dan
   merusak tampilan gelap. Tiap .menu-wrap berisi: tombol .pill (label + chevron),
   daftar .menu, dan input hidden sebagai sumber nilai (dibaca kode lain sebagai
   .value seperti <select> biasa). */
document.querySelectorAll(".menu-wrap").forEach((wrap) => {
  const btn = wrap.querySelector("[data-menu-btn]");
  const list = wrap.querySelector("[data-menu-list]");
  const hidden = wrap.querySelector("input[type=hidden]");
  const label = wrap.querySelector("[data-menu-label]");
  const items = [...list.querySelectorAll(".menu-item")];

  const close = () => {
    list.classList.add("hidden");
    btn.setAttribute("aria-expanded", "false");
  };

  const sync = () => {
    items.forEach((it) => it.classList.toggle("active", it.dataset.value === hidden.value));
    const active = items.find((it) => it.dataset.value === hidden.value);
    if (active) label.textContent = active.dataset.label;
  };

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    document.querySelectorAll("[data-menu-list]").forEach((l) => { if (l !== list) l.classList.add("hidden"); });
    const nowHidden = list.classList.toggle("hidden");
    btn.setAttribute("aria-expanded", String(!nowHidden));
  });

  items.forEach((it) => it.addEventListener("click", () => {
    hidden.value = it.dataset.value;
    sync();
    close();
  }));

  list.addEventListener("click", (e) => e.stopPropagation());
  document.addEventListener("click", close);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
  sync();
});

boot();
