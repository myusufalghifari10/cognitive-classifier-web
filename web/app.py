"""Web API + UI klasifikasi Cognitive Presence (CoI).

Jalankan (bind localhost — app ini TANPA login, jangan diekspos ke jaringan):
    ~/myenv/bin/python3 -m uvicorn web.app:app --host 127.0.0.1 --port 8000
"""
from __future__ import annotations

import asyncio
import json
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

app = FastAPI(title="Cognitive Classification — CoI")
app.mount("/static", StaticFiles(directory=STATIC), name="static")

JOBS: dict[str, dict] = {}


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
                              thinking=job["thinking"], concurrency=job["concurrency"],
                              on_record=on_record)
        job.update(status="done", metrics=res["metrics"], usage=res["usage"],
                   elapsed_s=res["elapsed_s"], n_parse_fail=res["n_parse_fail"])
    except Exception as exc:                              # noqa: BLE001 — tampil di UI
        job.update(status="error", error=f"{type(exc).__name__}: {exc}")


@app.post("/api/jobs")
async def api_create_job(file: UploadFile = File(...),
                         thinking: str = Form(""), concurrency: int = Form(8)):
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
           "mode": "few", "thinking": thinking or None,
           "concurrency": max(1, min(int(concurrency or 8), 16)), "dir": str(job_dir),
           "metrics": None, "usage": None, "error": None, "filename": file.filename,
           "created": datetime.now().isoformat(timespec="seconds")}
    JOBS[job_id] = job
    asyncio.create_task(_run_job(job, rows))
    return {"job_id": job_id, "total": len(rows), "has_gold": any(r["gold"] for r in rows)}


@app.get("/api/jobs/{job_id}")
async def api_job(job_id: str, after: int = -1):
    """Status + record dengan idx > `after` (client kirim idx terakhir yang sudah dilihat)."""
    job = JOBS.get(job_id)
    if not job:
        raise HTTPException(404, "Job tidak ditemukan.")
    fresh = sorted((r for r in job["records"] if r["idx"] > after), key=lambda r: r["idx"])
    return {"id": job_id, "status": job["status"], "done": job["done"], "total": job["total"],
            "records": fresh, "metrics": job["metrics"], "usage": job["usage"],
            "elapsed_s": job.get("elapsed_s"), "n_parse_fail": job.get("n_parse_fail"),
            "error": job["error"], "mode": job["mode"]}


@app.get("/api/jobs/{job_id}/download/{kind}")
async def api_download(job_id: str, kind: str):
    job = JOBS.get(job_id)
    if not job:
        raise HTTPException(404, "Job tidak ditemukan.")
    pattern = ARTIFACTS.get(kind)
    if not pattern:
        raise HTTPException(404, f"Artefak tidak dikenal: {kind}")
    name = pattern.format(tag=f"{job['mode']}shot")
    path = Path(job["dir"]) / name
    if not path.exists():
        raise HTTPException(404, f"{name} belum tersedia (job {job['status']}).")
    return FileResponse(path, filename=f"{job_id}_{name}")
