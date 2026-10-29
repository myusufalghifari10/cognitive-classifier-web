const $ = (sel) => document.querySelector(sel);

const state = {
  labels: ["C0", "C1", "C2", "C3", "C4"],
  names: [],
  job: null,
  rows: [],
  after: -1,
};

const CLASS_NAMES = [
  "Bukan Kehadiran Kognitif", "Pemantik Diskusi",
  "Eksplorasi", "Integrasi", "Resolusi",
];

/* ---------------- boot ---------------- */

async function boot() {
  renderLegend();
  try {
    const h = await (await fetch("/api/health")).json();
    state.labels = h.labels || state.labels;
    state.names = h.class_names || CLASS_NAMES;
    $("#status-dot").className = "dot " + (h.api_key ? "ok" : "bad");
    $("#status-text").textContent = h.api_key ? "API siap" : "API key belum ada";
    $("#model-line").textContent = `${h.model} · maks ${h.max_rows} baris/run`;
  } catch {
    $("#status-dot").className = "dot bad";
    $("#status-text").textContent = "backend tidak merespons";
  }
  renderChips();
}

function renderLegend() {
  $("#legend").innerHTML = state.labels
    .map((l, i) => `<li><code>${l}</code> ${CLASS_NAMES[i] || ""}</li>`)
    .join("");
}

function renderChips() {
  $("#chat-chips").innerHTML = state.labels
    .map((l, i) => `<span class="chip">${l} · ${CLASS_NAMES[i] || ""}</span>`)
    .join("");
}

/* ---------------- view switch ---------------- */

document.querySelectorAll(".nav-item").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".nav-item").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
    btn.classList.add("active");
    $(`#view-${btn.dataset.view}`).classList.add("active");
  });
});

/* ---------------- chat ---------------- */

const thread = $("#thread");
const input = $("#chat-input");
const sendBtn = $("#chat-send");
let threadInner = null;

function ensureThread() {
  if (!threadInner) {
    $("#chat-empty")?.remove();
    threadInner = document.createElement("div");
    threadInner.className = "thread-inner";
    thread.appendChild(threadInner);
  }
  return threadInner;
}

function bubble(text) {
  const wrap = document.createElement("div");
  wrap.className = "msg user";
  wrap.innerHTML = `<div class="avatar">YOU</div>
    <div class="body"><div class="who">Postingan</div><div class="text"></div></div>`;
  wrap.querySelector(".text").textContent = text;
  ensureThread().appendChild(wrap);
  thread.scrollTop = thread.scrollHeight;
  return wrap;
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
  ensureThread().appendChild(wrap);
  thread.scrollTop = thread.scrollHeight;
  return wrap;
}

function renderResult(shell, rec, liveReasoning) {
  const card = shell.querySelector(".card");
  const isFail = !state.labels.includes(rec.pred);
  const idx = state.labels.indexOf(rec.pred);
  const cls = isFail ? "FAIL" : rec.pred;
  const thinkText = liveReasoning || rec.thinking_head || "";
  const meta = [
    `${(rec.latency_ms / 1000).toFixed(1)}s`,
    rec.finish || "—",
    rec.budget ? `budget ${rec.budget}` : "",
  ].filter(Boolean).join(" · ");

  // .think ikut dibangun di sini: card.innerHTML membuang anak lama, jadi
  // jangan pernah query elemen anak sesudah baris ini.
  card.innerHTML = `
    <div class="card-head">
      <span class="badge ${cls}">${rec.pred}</span>
      <span class="class-name">${isFail ? "tidak terparse" : state.names[idx] || ""}</span>
      <span class="meta">${meta}</span>
    </div>
    <div class="reason"></div>
    ${thinkText ? `<details class="think"><summary>proses berpikir</summary><div class="think-body"></div></details>` : ""}`;
  card.querySelector(".reason").textContent =
    rec.reason || rec.error || "(model tidak memberi alasan)";
  const thinkBody = card.querySelector(".think-body");
  if (thinkBody) thinkBody.textContent = thinkText;
}

async function sendChat(ev) {
  ev.preventDefault();
  const text = input.value.trim();
  if (!text) return;

  sendBtn.disabled = true;
  input.value = "";
  input.style.height = "auto";
  bubble(text);
  const shell = assistantShell();
  const pending = shell.querySelector(".pending-text");
  const think = shell.querySelector(".think");
  const thinkBody = shell.querySelector(".think-body");
  let reasoning = "";
  let raf = 0;
  // ~2500 delta per sampel: tulis DOM sekali per frame, bukan per token.
  const repaintThink = () => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      think.classList.remove("hidden");
      thinkBody.textContent = reasoning.slice(-4000);
      thinkBody.scrollTop = thinkBody.scrollHeight;
    });
  };

  try {
    const res = await fetch("/api/classify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, mode: $("#chat-mode").value }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let done = false;
    while (!done) {
      const { value, done: end } = await reader.read();
      if (end) break;
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
          repaintThink();
          pending.textContent = ev === "reasoning" ? "berpikir…" : "menyusun jawaban…";
        } else if (ev === "result") {
          renderResult(shell, data, reasoning);
          done = true;
        } else if (ev === "error") {
          throw new Error(data.message);
        }
      }
    }
  } catch (err) {
    shell.querySelector(".card").innerHTML =
      `<div class="card-head"><span class="badge FAIL">ERROR</span></div>
       <div class="reason"></div>`;
    shell.querySelector(".reason").textContent = String(err.message || err);
  } finally {
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
  input.style.height = Math.min(input.scrollHeight, 200) + "px";
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
  fd.append("mode", $("#batch-mode").value);
  fd.append("thinking", $("#batch-thinking").value);
  fd.append("concurrency", $("#batch-conc").value);

  try {
    const res = await fetch("/api/jobs", { method: "POST", body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);

    state.job = data.job_id;
    state.rows = [];
    state.after = -1;
    $("#result-body").innerHTML = "";
    $("#metrics").innerHTML = "";
    $("#result-panel").classList.remove("hidden");
    $("#table-tools").classList.toggle("hidden", !data.has_gold);
    $("#progress-wrap").classList.remove("hidden");
    $("#only-wrong").checked = false;
    document.querySelectorAll(".downloads .ghost").forEach((a) => a.classList.add("disabled"));
    setProgress(0, data.total);
    poll();
  } catch (err) {
    $("#result-panel").classList.remove("hidden");
    $("#metrics").innerHTML = `<div class="metric"><span>error</span><strong>gagal</strong></div>`;
    $("#result-body").innerHTML =
      `<tr><td colspan="5" class="reason">${err.message}</td></tr>`;
    $("#batch-start").disabled = false;
  }
});

function setProgress(done, total) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  $("#progress-label").textContent = `${done} / ${total}`;
  $("#progress-pct").textContent = `${pct}%`;
  $("#progress-bar").style.width = `${pct}%`;
}

async function poll() {
  try {
    const res = await fetch(`/api/jobs/${state.job}?after=${state.after}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);

    for (const rec of data.records) {
      state.rows.push(rec);
      state.after = Math.max(state.after, rec.idx);
      appendRow(rec);
    }
    setProgress(data.done, data.total);

    if (data.status === "done" || data.status === "error") {
      finishJob(data);
      return;
    }
    setTimeout(poll, 900);
  } catch (err) {
    $("#metrics").innerHTML =
      `<div class="metric"><span>error</span><strong>polling gagal</strong></div>`;
    $("#batch-start").disabled = false;
    console.error(err);
  }
}

function appendRow(rec) {
  if ($("#only-wrong").checked && rec.gold && rec.pred === rec.gold) return;
  const tr = document.createElement("tr");
  const wrong = rec.gold && rec.pred !== rec.gold;
  if (wrong) tr.classList.add("wrong");
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
    a.classList.remove("disabled");
    a.href = `/api/jobs/${state.job}/download/${a.dataset.kind}`;
  });
  if (data.status === "error") {
    $("#metrics").insertAdjacentHTML(
      "beforeend", `<div class="metric"><span>error</span><strong>${data.error || ""}</strong></div>`);
  }
}

boot();
