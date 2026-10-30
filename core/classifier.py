"""Klasifikasi Cognitive Presence (CoI) 5 kelas via DeepSeek API.

Prompt di `prompts/` disalin byte-identik dari project benchmark
(`Cognitive-Classification-Using-LLM/prompts/`) — itu satu-satunya jaminan hasil
app ini setara dengan report benchmark di sana.

Beda transport yang dipaksa DeepSeek (bukan pilihan kita):
  - `response_format` hanya `{"type": "json_object"}`; `json_schema` tidak didukung.
  - Docs resmi memperingatkan JSON Output kadang mengembalikan content kosong →
    parser fallback ke `reasoning_content` (sama seperti `eval.py` project lama).
"""
from __future__ import annotations

import asyncio
import json
import os
import random
import re
import time
from pathlib import Path

import httpx

LABELS = ["C0", "C1", "C2", "C3", "C4"]
CLASS_NAMES = [
    "Bukan Kehadiran Kognitif",
    "Pemantik Diskusi",
    "Eksplorasi",
    "Integrasi",
    "Resolusi",
]

# Ringkasan rubrik `prompts/system_few_shot.md` (definisi + pembeda), dipadatkan.
# Ini satu-satunya sumber: legenda di UI mengambil daftar ini lewat /api/health,
# supaya teks legenda tidak bisa diam-diam menyimpang dari rubrik.
CLASS_DEFS = [
    "Sapaan, terima kasih, logistik, dukungan sosial. Tanpa isi materi.",
    "Bertanya atau mengaku bingung. Ada percikan inkuiri, belum menyumbang jawaban.",
    "Berbagi info, definisi, contoh, atau opini beralasan. Belum menyintesis.",
    "Menyintesis, merefleksi, atau menyusun pembuktian langkah demi langkah.",
    "Simpulan final yang menutup masalah; solusi dipertahankan atau diuji.",
]

ROOT = Path(__file__).resolve().parent.parent
PROMPT_DIR = ROOT / "prompts"
DEFAULT_BASE_URL = "https://api.deepseek.com"
DEFAULT_MODEL = "deepseek-flash"

_system_cache: dict[str, str] = {}


def api_key() -> str:
    key = os.environ.get("DEEPSEEK_API_KEY", "").strip()
    if not key:
        p = Path.home() / ".deepseek_key"
        if p.exists():
            key = p.read_text(encoding="utf-8").strip()
    if not key:
        raise RuntimeError(
            "DEEPSEEK_API_KEY kosong dan ~/.deepseek_key tidak ada. "
            "Set env DEEPSEEK_API_KEY atau taruh key di ~/.deepseek_key."
        )
    return key


def system_prompt(mode: str) -> str:
    if mode not in ("few", "zero"):
        raise ValueError(f"mode harus 'few' atau 'zero', bukan {mode!r}")
    if mode not in _system_cache:
        _system_cache[mode] = (PROMPT_DIR / f"system_{mode}_shot.md").read_text(encoding="utf-8")
    return _system_cache[mode]


def user_template() -> str:
    return (PROMPT_DIR / "user.md").read_text(encoding="utf-8")


def make_client(base_url: str = DEFAULT_BASE_URL, key: str | None = None,
                timeout: float = 1800.0) -> httpx.AsyncClient:
    return httpx.AsyncClient(
        base_url=base_url.rstrip("/") + "/",
        headers={"Authorization": f"Bearer {key or api_key()}"},
        timeout=timeout,
    )


def build_messages(system: str, user_tpl: str, text: str) -> list[dict]:
    return [
        {"role": "system", "content": system},
        {"role": "user", "content": user_tpl.replace("{text}", text)},
    ]


def split_think_answer(content: str, reasoning: str) -> tuple[str, str]:
    """Pisahkan thinking dari jawaban final. Menerima thinking yang sudah di field
    sendiri maupun yang masih inline <think>...</think>."""
    thinking = reasoning or ""
    answer = content or ""
    m = re.search(r"<think>(.*?)</think>(.*)", answer, re.DOTALL)
    if m:
        thinking = (thinking + "\n" + m.group(1)).strip()
        answer = m.group(2).strip()
    return answer, thinking


def parse_label(content: str) -> tuple[str | None, str | None]:
    """Ambil (label, alasan) dari output. 3 lapis: JSON utuh → JSON terkubun → regex C0-C4."""
    if not content or not content.strip():
        return None, None
    try:
        data = json.loads(content)
        lab = str(data.get("label", "")).strip().upper()
        if lab in LABELS:
            return lab, str(data.get("alasan", "")).strip()
    except (json.JSONDecodeError, AttributeError):
        pass
    m = re.search(r"\{.*\}", content, re.DOTALL)
    if m:
        try:
            data = json.loads(m.group(0))
            lab = str(data.get("label", "")).strip().upper()
            if lab in LABELS:
                return lab, str(data.get("alasan", "")).strip()
        except json.JSONDecodeError:
            pass
    m = re.search(r"\bC[0-4]\b", content)
    if m:
        return m.group(0), None
    return None, None


def _body(messages, model, max_tokens, thinking, stream) -> dict:
    body = {
        "model": model,
        "messages": messages,
        "seed": 42,
        "max_tokens": max_tokens,
        "stream": stream,
        "response_format": {"type": "json_object"},
    }
    if stream:
        body["stream_options"] = {"include_usage": True}
    if thinking == "off":
        body["thinking"] = {"type": "disabled"}
    elif thinking in ("low", "high", "max"):
        body["thinking"] = {"type": "enabled"}
        body["reasoning_effort"] = thinking
    return body


async def _call(client, messages, model, max_tokens, thinking, on_delta):
    """Satu request. on_delta=None → non-stream; kalau ada → stream dan diteruskan
    per delta. Mengembalikan (content, reasoning, finish_reason, latency_ms, usage)."""
    body = _body(messages, model, max_tokens, thinking, stream=on_delta is not None)
    t0 = time.time()

    if on_delta is None:
        r = await client.post("chat/completions", json=body)
        r.raise_for_status()
        data = r.json()
        if not data.get("choices"):
            raise ValueError(f"API error: {json.dumps(data.get('error', data), ensure_ascii=False)[:200]}")
        choice = data["choices"][0]
        msg = choice["message"] or {}
        return (msg.get("content") or "", msg.get("reasoning_content") or "",
                choice.get("finish_reason") or "", (time.time() - t0) * 1000,
                data.get("usage"))

    content: list[str] = []
    reasoning: list[str] = []
    finish = ""
    usage = None
    async with client.stream("POST", "chat/completions", json=body) as resp:
        resp.raise_for_status()
        async for line in resp.aiter_lines():
            if not line.startswith("data:"):
                continue
            payload = line[5:].strip()
            if payload == "[DONE]":
                break
            chunk = json.loads(payload)
            if not chunk.get("choices"):
                continue
            choice = chunk["choices"][0]
            delta = choice.get("delta") or {}
            if delta.get("reasoning_content"):
                reasoning.append(delta["reasoning_content"])
                on_delta("reasoning", delta["reasoning_content"])
            if delta.get("content"):
                content.append(delta["content"])
                on_delta("content", delta["content"])
            finish = choice.get("finish_reason") or finish
            usage = chunk.get("usage") or usage
    return ("".join(content), "".join(reasoning), finish,
            (time.time() - t0) * 1000, usage)


async def classify(client, text: str, *, mode: str = "few", model: str = DEFAULT_MODEL,
                   thinking: str | None = None, max_tokens: int = 32768,
                   max_budget: int = 131072, on_delta=None) -> dict:
    """Klasifikasi satu postingan.

    Anggaran token mulai dari 32768. Bila jawaban terpotong (finish="length"),
    anggaran naik dua kali lipat: 32768 -> 65536 -> 131072, jadi soal yang butuh
    penalaran sangat panjang tidak berakhir sebagai jawaban gagal urai.

    `on_delta(kind, teks)` dipanggil per potongan saat streaming ("reasoning"/"content").
    Return dict dengan field identik `predictions_*.jsonl` project lama (tanpa idx/gold).
    """
    messages = build_messages(system_prompt(mode), user_template(), text)
    budget = max_tokens
    pred = reason = answer = thinking_txt = ""
    latency = 0.0
    finish = ""
    err = ""
    usage = None

    for attempt in range(4):
        try:
            raw, reasoning, finish, latency, usage = await _call(
                client, messages, model, budget, thinking, on_delta)
        except (httpx.HTTPError, json.JSONDecodeError, ValueError) as e:
            err = f"{type(e).__name__}: {e}"
            if attempt < 3:
                await asyncio.sleep(2 ** attempt + random.uniform(0, 0.5))
            continue

        answer, thinking_txt = split_think_answer(raw, reasoning)
        pred, reason = parse_label(answer)
        if not pred and thinking_txt:
            # Reasoning yang TERPOTONG (finish=length) tidak boleh dikorek labelnya:
            # label yang muncul di tengah rantai berpikir masih pertimbangan, bukan
            # kesimpulan. Naikkan budget dulu; korek hanya bila budget sudah mentok.
            if finish == "length" and budget < max_budget:
                budget = min(budget * 2, max_budget)
                err = f"thinking terpotong, retry budget={budget}"
                continue
            pred, reason = parse_label(thinking_txt)
            if pred:
                answer = thinking_txt
        if pred:
            break
        if finish == "length" and budget < max_budget:
            budget = min(budget * 2, max_budget)
            err = f"truncated, retry budget={budget}"
            continue
        err = f"tidak terparse (finish={finish}, attempt {attempt+1})"

    return {
        "text": text[:500],
        "pred": pred or "PARSE_FAIL",
        "reason": reason,
        "latency_ms": round(latency, 1),
        "answer_head": answer[:160],
        "thinking_head": thinking_txt[:500],
        "finish": finish,
        "budget": budget,
        "usage": usage,
        "error": err,
    }
