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
};

const thread = $("#thread");
const threadInner = $("#thread-inner");
const chatEmpty = $("#chat-empty");
const chatView = $("#view-chat");
const input = $("#chat-input");
const sendBtn = $("#chat-send");

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
  try {
    const h = await api("/api/health");
    state.labels = h.labels || state.labels;
    state.names = h.class_names || CLASS_NAMES;
    renderLegend();
  } catch {
    // biarkan nilai default lokal; daftar sesi tetap dicoba di bawah
  }
  await loadSessions(true);
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

function renderSessionList() {
  const list = $("#session-list");
  if (!state.sessions.length) {
    list.innerHTML = `<p class="session-empty">Belum ada sesi.</p>`;
    return;
  }
  // Hanya bangun ulang kalau memang perlu: kalau user sedang mengganti nama
  // (ada <input> di dalam list), jangan sentuh DOM-nya.
  if (list.querySelector(".session-rename")) return;
  list.innerHTML = state.sessions.map((s) => {
    const isBatch = s.kind === "batch";
    const sub = isBatch
      ? [`CSV · ${s.n_rows ?? 0} baris`,
         s.accuracy != null ? `${(s.accuracy * 100).toFixed(1)}%` : null,
         s.status && s.status !== "done" ? s.status : null].filter(Boolean).join(" · ")
      : `${s.n_messages} pesan`;
    return `
    <div class="session-item${s.id === state.active ? " active" : ""}" data-id="${s.id}">
      <button class="session-open" data-act="open">
        <span class="session-line">
          ${isBatch ? '<span class="kind">CSV</span>' : ""}
          <span class="session-title"></span>
        </span>
        <small>${sub} · ${fmtWhen(s.updated_at)}</small>
      </button>
      <div class="session-actions">
        <button data-act="rename" title="Ganti nama" aria-label="Ganti nama">
          <svg viewBox="0 0 24 24"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>
        </button>
        <button data-act="delete" title="Hapus" aria-label="Hapus">
          <svg viewBox="0 0 24 24"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg>
        </button>
      </div>
    </div>`;
  }).join("");

  // judul diisi via textContent (judul bisa berasal dari teks user)
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
  const after = state.rows.length ? state.rows[state.rows.length - 1].idx : -1;

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
    startPoll(data.id, data.job_id, after);
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

function startPoll(sessionId, jobId, after) {
  stopPoll();
  state.poll = { sessionId, jobId, after, timer: null };
  tick();
}

async function tick() {
  const p = state.poll;
  if (!p) return;
  try {
    const res = await fetch(`/api/jobs/${p.jobId}?after=${p.after}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);
    if (state.poll !== p) return;          // user pindah sesi: hentikan render

    for (const rec of data.records) {
      p.after = Math.max(p.after, rec.idx);
      state.rows.push(rec);
      appendRow(rec);
    }
    setProgress(data.done, data.total);

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

async function deleteSession(id) {
  const s = state.sessions.find((x) => x.id === id);
  if (!s) return;
  const isBatch = s.kind === "batch";
  if (!confirm(isBatch
    ? `Hapus sesi "${s.title}" dari daftar? Berkas hasil di runs/ tetap tersimpan.`
    : `Hapus sesi "${s.title}"? Riwayatnya hilang permanen.`)) return;
  try {
    await api(`/api/sessions/${id}`, { method: "DELETE" });
  } catch (err) {
    alert(`Gagal hapus: ${err.message}`);
    return;
  }
  state.sessions = state.sessions.filter((x) => x.id !== id);
  // Sesi aktif dihapus -> kosongkan, jangan auto-buka sesi lain (sama seperti
  // deleteConversation llama.cpp: clearActiveConversation).
  if (state.active === id) {
    state.active = null;
    stopPoll();
    $("#result-panel").classList.add("hidden");
    $("#progress-wrap").classList.add("hidden");
    showEmpty();
  }
  renderSessionList();
}

$("#session-list").addEventListener("click", (e) => {
  const item = e.target.closest(".session-item");
  if (!item) return;
  const act = e.target.closest("[data-act]")?.dataset.act;
  const id = item.dataset.id;
  if (act === "rename") renameSession(id, item);
  else if (act === "delete") deleteSession(id);
  else if (act === "open" && id !== state.active) openSession(id);
});

$("#new-session").addEventListener("click", () => newSession());

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

function cardHtml(rec, thinkText) {
  const isFail = !state.labels.includes(rec.pred);
  const idx = state.labels.indexOf(rec.pred);
  const cls = isFail ? "FAIL" : rec.pred;
  const meta = [
    rec.latency_ms ? `${(rec.latency_ms / 1000).toFixed(1)}s` : "",
    rec.finish || "",
    rec.budget ? `budget ${rec.budget}` : "",
  ].filter(Boolean).join(" · ");
  return `
    <div class="card-head">
      <span class="badge ${cls}">${rec.pred}</span>
      <span class="class-name">${isFail ? "tidak terparse" : state.names[idx] || ""}</span>
      <span class="meta">${meta}</span>
    </div>
    <div class="reason"></div>
    ${thinkText ? `<details class="think"><summary>proses berpikir</summary><div class="think-body"></div></details>` : ""}`;
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
        <div class="pending"><span class="pulse"></span><span class="pending-text">menganalisis…</span></div>
        <details class="think hidden"><summary>proses berpikir</summary><div class="think-body"></div></details>
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
      body: JSON.stringify({ text }),
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
    const card = shell?.querySelector(".card");
    if (card) {
      card.innerHTML = `<div class="card-head"><span class="badge FAIL">ERROR</span></div>
        <div class="reason"></div>`;
      card.querySelector(".reason").textContent = String(err.message || err);
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
});

/* ---------------- view switch ---------------- */

function switchView(name) {
  document.querySelectorAll(".nav-item").forEach((b) =>
    b.classList.toggle("active", b.dataset.view === name));
  document.querySelectorAll(".view").forEach((v) =>
    v.classList.toggle("active", v.id === `view-${name}`));
}

document.querySelectorAll(".nav-item").forEach((btn) => {
  btn.addEventListener("click", () => switchView(btn.dataset.view));
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
  $("#drop-sub").textContent = `${(file.size / 1024).toFixed(1)} KB — siap diklasifikasi`;
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
    startPoll(data.session_id, data.job_id, -1);
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
  if (rec.gold && rec.pred !== rec.gold) tr.classList.add("wrong");
  tr.innerHTML = `
    <td class="idx">${rec.idx}</td>
    <td class="pred"><span class="badge ${rec.pred}">${rec.pred}</span></td>
    <td class="gold">${rec.gold || "—"}</td>
    <td class="reason"></td>
    <td class="idx">${(rec.latency_ms / 1000).toFixed(1)}s</td>`;
  tr.querySelector(".reason").textContent = rec.reason || rec.error || "";
  $("#result-body").appendChild(tr);
}

function rerenderRows() {
  $("#result-body").innerHTML = "";
  state.rows.forEach(appendRow);
}

$("#only-wrong").addEventListener("change", rerenderRows);

function finishJob(data) {
  $("#batch-start").disabled = false;
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

boot();
