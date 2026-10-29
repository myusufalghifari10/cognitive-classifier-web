"""Web API + UI klasifikasi Cognitive Presence (CoI).

Jalankan (bind localhost — app ini TANPA login, jangan diekspos ke jaringan):
    ~/myenv/bin/python3 -m uvicorn web.app:app --host 127.0.0.1 --port 8000
"""
from __future__ import annotations

import asyncio
import json
import os
import uuid
from datetime import datetime
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from core import batch, classifier

ROOT = Path(__file__).resolve().parent.parent
RUNS = ROOT / "runs"
STATIC = Path(__file__).resolve().parent / "static"
RUNS.mkdir(exist_ok=True)

MAX_ROWS = 1000          # pagar biaya: tanpa login, endpoint ini bisa membakar kredit
ARTIFACTS = {"csv": "results_{tag}.csv", "report": "report_{tag}.txt",
             "png": "confusion_matrix_{tag}.png", "jsonl": "predictions_{tag}.jsonl"}

# History chat: satu file per session (delete/rename = operasi file, kerusakan
# terbatas satu session, tidak perlu rewrite seluruh riwayat tiap pesan).
SESSIONS = ROOT / "data" / "sessions"
SESSIONS.mkdir(parents=True, exist_ok=True)
_session_lock = asyncio.Lock()

app = FastAPI(title="Cognitive Classification — CoI")
app.mount("/static", StaticFiles(directory=STATIC), name="static")

JOBS: dict[str, dict] = {}


def _now() -> str:
    return datetime.now().isoformat(timespec="seconds")


def _session_path(session_id: str) -> Path:
    if not (len(session_id) == 12 and all(c in "0123456789abcdef" for c in session_id)):
        raise HTTPException(400, "id session tidak valid")
    return SESSIONS / f"{session_id}.json"


def _read_session(session_id: str) -> dict:
    path = _session_path(session_id)
    if not path.exists():
        raise HTTPException(404, "Session tidak ditemukan.")
    return json.loads(path.read_text(encoding="utf-8"))


def _write_session(data: dict) -> None:
    path = _session_path(data["id"])
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    os.replace(tmp, path)          # atomik: session tidak pernah setengah tertulis


async def _update_session(session_id: str, **fields) -> None:
    """Patch sebagian field session (dipakai job batch untuk update status)."""
    async with _session_lock:
        try:
            data = _read_session(session_id)
        except HTTPException:
            return
        data.update(fields)
        data["updated_at"] = _now()
        _write_session(data)


def _load_batch_records(job_id: str, mode: str) -> list[dict]:
    path = RUNS / job_id / f"predictions_{mode}shot.jsonl"
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


@app.get("/")
async def index():
    return FileResponse(STATIC / "index.html")


@app.get("/api/health")
async def health():
    try:
        key_ok = bool(classifier.api_key())
    except RuntimeError:
        key_ok = False
    return {"ok": True, "model": classifier.DEFAULT_MODEL, "api_key": key_ok,
            "labels": classifier.LABELS, "class_names": classifier.CLASS_NAMES,
            "max_rows": MAX_ROWS}


@app.post("/api/classify")
async def api_classify(payload: dict):
    """Klasifikasi satu postingan; hasil di-stream sebagai SSE (reasoning + content + result)."""
    text = (payload.get("text") or "").strip()
    if not text:
        raise HTTPException(400, "Teks postingan kosong.")
    thinking = payload.get("thinking") or None

    async def events():
        queue: asyncio.Queue = asyncio.Queue()

        def on_delta(kind: str, chunk: str) -> None:
            queue.put_nowait(("delta", kind, chunk))

        async def worker() -> None:
            try:
                async with classifier.make_client() as client:
                    rec = await classifier.classify(client, text, thinking=thinking,
                                                    on_delta=on_delta)
                queue.put_nowait(("result", rec, None))
            except Exception as exc:                      # noqa: BLE001 — dilaporkan ke UI
                queue.put_nowait(("error", None, f"{type(exc).__name__}: {exc}"))
            finally:
                queue.put_nowait(("end", None, None))

        task = asyncio.create_task(worker())
        yield sse("start", {"thinking": thinking})
        while True:
            kind, payload, extra = await queue.get()
            if kind == "delta":
                yield sse(payload, {"delta": extra})     # payload = "reasoning" | "content"
            elif kind == "result":
                yield sse("result", payload)
            elif kind == "error":
                yield sse("error", {"message": extra})
            else:
                break
        await task

    return StreamingResponse(events(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


async def _run_job(job: dict, rows: list[dict]) -> None:
    job["status"] = "running"

    async def on_record(rec: dict, done: int, total: int) -> None:
        job["records"].append(rec)
        job["done"] = done

    try:
        res = await batch.run(rows, Path(job["dir"]), mode=job["mode"],
                              thinking=job["thinking"], on_record=on_record)
        m = res["metrics"]
        job.update(status="done", metrics=m, usage=res["usage"],
                   elapsed_s=res["elapsed_s"], n_parse_fail=res["n_parse_fail"],
                   parallel=res["parallel"])
        await _update_session(job["session_id"], status="done", usage=res["usage"],
                              elapsed_s=res["elapsed_s"], n_parse_fail=res["n_parse_fail"],
                              parallel=res["parallel"], accuracy=m.get("accuracy"),
                              macro_f1=m.get("macro_f1"), n_gold=m.get("n_gold", 0))
    except Exception as exc:                              # noqa: BLE001 — tampil di UI
        job.update(status="error", error=f"{type(exc).__name__}: {exc}")
        await _update_session(job["session_id"], status="error", error=str(exc)[:300])


@app.post("/api/jobs")
async def api_create_job(file: UploadFile = File(...), thinking: str = Form("")):
    raw = await file.read()
    job_id = uuid.uuid4().hex[:12]
    job_dir = RUNS / job_id
    job_dir.mkdir(parents=True, exist_ok=True)
    csv_path = job_dir / "input.csv"
    csv_path.write_bytes(raw)

    try:
        rows = batch.read_csv(csv_path)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    if len(rows) > MAX_ROWS:
        raise HTTPException(400, f"CSV berisi {len(rows)} baris, batas {MAX_ROWS} per run.")

    job = {"id": job_id, "status": "queued", "total": len(rows), "done": 0, "records": [],
           "mode": "few", "thinking": thinking or None, "dir": str(job_dir),
           "metrics": None, "usage": None, "error": None, "filename": file.filename,
           "created": _now()}
    # Hasil CSV langsung jadi sesi supaya bisa dibuka lagi dari sidebar.
    session_id = uuid.uuid4().hex[:12]
    title = f"CSV · {file.filename or 'upload'}"[:80]
    async with _session_lock:
        _write_session({"id": session_id, "kind": "batch", "title": title,
                        "job_id": job_id, "mode": "few", "thinking": thinking or None,
                        "total": len(rows), "status": "queued", "messages": [],
                        "created_at": _now(), "updated_at": _now()})
    job["session_id"] = session_id
    JOBS[job_id] = job
    asyncio.create_task(_run_job(job, rows))
    return {"job_id": job_id, "session_id": session_id, "title": title,
            "total": len(rows), "has_gold": any(r["gold"] for r in rows)}


@app.get("/api/jobs/{job_id}")
async def api_job(job_id: str, offset: int = 0):
    """Status + record setelah `offset` (client mengirim jumlah record yang sudah diterima).

    Kursor berbasis jumlah, bukan idx: baris selesai tidak berurutan (paralel), jadi
    filter `idx > after` melewatkan baris yang selesai belakangan dengan idx lebih kecil.
    """
    job = JOBS.get(job_id)
    if not job:
        raise HTTPException(404, "Job tidak ditemukan.")
    fresh = job["records"][max(0, offset):]
    return {"id": job_id, "status": job["status"], "done": job["done"], "total": job["total"],
            "records": fresh, "metrics": job["metrics"], "usage": job["usage"],
            "elapsed_s": job.get("elapsed_s"), "n_parse_fail": job.get("n_parse_fail"),
            "error": job["error"], "mode": job["mode"]}


@app.get("/api/sessions/{session_id}/download/{kind}")
async def api_session_download(session_id: str, kind: str):
    """Unduh artefak job batch lewat sesinya (bertahan setelah server restart)."""
    data = _read_session(session_id)
    if (data.get("kind") or "chat") != "batch":
        raise HTTPException(400, "Session ini bukan hasil klasifikasi CSV.")
    pattern = ARTIFACTS.get(kind)
    if not pattern:
        raise HTTPException(404, f"Artefak tidak dikenal: {kind}")
    name = pattern.format(tag=f"{(data.get('mode') or 'few')}shot")
    path = RUNS / data["job_id"] / name
    if not path.exists():
        raise HTTPException(404, f"{name} belum tersedia (status {data.get('status')}).")
    return FileResponse(path, filename=f"{session_id}_{name}")


# ---------------------------------------------------------------- sessions

@app.get("/api/sessions")
async def api_sessions():
    items = []
    for path in SESSIONS.glob("*.json"):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            continue                   # satu file rusak jangan menjatuhkan seluruh daftar
        kind = data.get("kind") or "chat"
        items.append({"id": data["id"], "kind": kind,
                      "title": data.get("title") or "Sesi baru",
                      "updated_at": data.get("updated_at"),
                      "pinned": bool(data.get("pinned")),
                      "n_messages": len(data.get("messages") or []),
                      "n_rows": data.get("total") if kind == "batch" else None,
                      "status": data.get("status"),
                      "accuracy": data.get("accuracy")})
    items.sort(key=lambda x: x["updated_at"] or "", reverse=True)
    return {"sessions": items}


def _snippet(text: str, needle: str, width: int = 110) -> str:
    """Potongan teks di sekitar kecocokan supaya hasil pencarian bisa dibaca."""
    low = text.lower()
    i = low.find(needle)
    if i < 0:
        return text[:width] + ("..." if len(text) > width else "")
    start = max(0, i - width // 3)
    end = min(len(text), i + len(needle) + width)
    return (("..." if start else "") + text[start:end].strip()
            + ("..." if end < len(text) else ""))


@app.get("/api/sessions/search")
async def api_sessions_search(q: str = "", limit: int = 30):
    """Cari di judul DAN isi pesan. Didaftarkan sebelum rute {session_id} agar
    'search' tidak diperlakukan sebagai id sesi."""
    needle = (q or "").strip().lower()
    if len(needle) < 2:
        return {"query": q, "results": []}
    results = []
    for path in SESSIONS.glob("*.json"):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            continue
        title = data.get("title") or "Sesi baru"
        hits = []
        if needle in title.lower():
            hits.append({"role": "title", "snippet": title})
        for msg in data.get("messages") or []:
            body = msg.get("text") or msg.get("reason") or ""
            if needle in body.lower():
                hits.append({"role": msg.get("role") or "assistant",
                             "snippet": _snippet(body, needle)})
            if len(hits) >= 4:
                break
        if hits:
            results.append({"id": data["id"], "kind": data.get("kind") or "chat",
                            "title": title, "updated_at": data.get("updated_at"),
                            "pinned": bool(data.get("pinned")),
                            "n_messages": len(data.get("messages") or []),
                            "hits": hits[:4]})
    results.sort(key=lambda r: r["updated_at"] or "", reverse=True)
    return {"query": q, "results": results[:max(1, min(limit, 100))]}


@app.get("/api/sessions/{session_id}")
async def api_session_get(session_id: str):
    data = _read_session(session_id)
    if (data.get("kind") or "chat") == "batch":
        # Record dibaca dari artefak di disk, bukan dari memori: tetap ada setelah restart.
        records = _load_batch_records(data["job_id"], data.get("mode") or "few")
        tag = f"{(data.get('mode') or 'few')}shot"
        job_dir = RUNS / data["job_id"]
        data["records"] = records
        data["metrics"] = batch.compute_metrics(records)
        data["artifacts"] = {k: (job_dir / v.format(tag=tag)).exists()
                             for k, v in ARTIFACTS.items()}
    return data


@app.patch("/api/sessions/{session_id}")
async def api_session_update(session_id: str, payload: dict):
    """Ubah judul dan/atau status pin. updated_at sengaja tidak disentuh supaya
    pin/rename tidak mengacak urutan grup tanggal."""
    async with _session_lock:
        data = _read_session(session_id)
        if "title" in payload:
            title = (payload.get("title") or "").strip()[:80]
            if not title:
                raise HTTPException(400, "Judul tidak boleh kosong.")
            data["title"] = title
        if "pinned" in payload:
            data["pinned"] = bool(payload["pinned"])
        _write_session(data)
    return {"id": session_id, "title": data.get("title"),
            "pinned": bool(data.get("pinned"))}


@app.delete("/api/sessions/{session_id}")
async def api_session_delete(session_id: str):
    path = _session_path(session_id)
    if not path.exists():
        raise HTTPException(404, "Session tidak ditemukan.")
    async with _session_lock:
        path.unlink()
    return {"deleted": session_id}


@app.post("/api/sessions/{session_id}/messages")
async def api_session_append(session_id: str, payload: dict):
    """Simpan satu pesan: user {text} atau assistant {pred, reason, thinking, latency_ms}."""
    role = payload.get("role")
    if role not in ("user", "assistant"):
        raise HTTPException(400, "role harus 'user' atau 'assistant'.")
    msg = {k: v for k, v in payload.items() if k != "role"}
    if role == "user":
        msg["text"] = (msg.get("text") or "").strip()
        if not msg["text"]:
            raise HTTPException(400, "text kosong.")
    msg["role"] = role
    msg["at"] = _now()
    async with _session_lock:
        data = _read_session(session_id)
        if (data.get("kind") or "chat") == "batch":
            raise HTTPException(400, "Sesi hasil CSV tidak menerima pesan chat.")
        data["messages"].append(msg)
        if role == "user" and data.get("title") in (None, "", "Sesi baru"):
            data["title"] = msg["text"][:60]      # judul otomatis dari pesan pertama
        data["updated_at"] = msg["at"]
        _write_session(data)
    return {"ok": True, "title": data["title"], "n_messages": len(data["messages"])}
