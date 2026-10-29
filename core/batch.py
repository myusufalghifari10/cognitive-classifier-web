"""Batch klasifikasi CSV → predictions.jsonl + results.csv + report.txt + confusion_matrix.png.

Artefak sengaja memakai nama & format yang sama dengan project benchmark
(`results/<model>/<phase>/<variant>/`) supaya report kita bisa di-diff langsung.

CLI:
    python -m core.batch --csv data/test_dataset.csv --out runs/verify120 \
        --mode few --concurrency 8
"""
from __future__ import annotations

import argparse
import asyncio
import csv
import json
import time
from pathlib import Path

from . import classifier

TEXT_ALIASES = ("text", "postingan", "isi", "content")
LABEL_ALIASES = ("label", "gold", "kelas")


def read_csv(path: str | Path) -> list[dict]:
    """Baca CSV → [{idx, text, gold}]. Kolom teks wajib; kolom gold opsional."""
    with open(path, newline="", encoding="utf-8-sig") as fh:
        reader = csv.DictReader(fh)
        cols = [c for c in (reader.fieldnames or []) if c]
        text_col = next((c for c in cols if c.strip().lower() in TEXT_ALIASES), None)
        if not text_col:
            raise ValueError(
                f"CSV harus punya kolom teks (salah satu dari {TEXT_ALIASES}). "
                f"Kolom ditemukan: {cols}")
        label_col = next((c for c in cols if c.strip().lower() in LABEL_ALIASES), None)
        rows: list[dict] = []
        for r in reader:
            text = (r.get(text_col) or "").strip()
            if not text:
                continue
            gold = (r.get(label_col) or "").strip().upper() if label_col else ""
            rows.append({"idx": len(rows), "text": text,
                         "gold": gold if gold in classifier.LABELS else None})
    if not rows:
        raise ValueError("CSV tidak berisi baris dengan teks.")
    return rows


def usage_summary(records: list[dict]) -> dict | None:
    """Total token dari field `usage` DeepSeek + biaya USD (harga peak deepseek-flash:
    input cache-miss $0.3/M, cache-hit $0.006/M, output $1.2/M). Estimasi, bukan tagihan."""
    usages = [r["usage"] for r in records if r.get("usage")]
    if not usages:
        return None
    in_hit = sum(u.get("prompt_cache_hit_tokens") or 0 for u in usages)
    in_miss = sum(u.get("prompt_cache_miss_tokens") or 0 for u in usages)
    out_tok = sum(u.get("completion_tokens") or 0 for u in usages)
    if not in_hit and not in_miss:
        in_miss = sum(u.get("prompt_tokens") or 0 for u in usages)
    usd = in_hit / 1e6 * 0.006 + in_miss / 1e6 * 0.3 + out_tok / 1e6 * 1.2
    return {"input_hit": in_hit, "input_miss": in_miss, "output": out_tok, "usd": round(usd, 4)}


def compute_metrics(records: list[dict]) -> dict:
    """Metrik hanya untuk baris yang punya gold. Sama persis dengan eval.py project lama."""
    from sklearn.metrics import accuracy_score, classification_report, confusion_matrix, f1_score

    pairs = [(r["pred"], r["gold"]) for r in records if r.get("gold")]
    if not pairs:
        return {"n_gold": 0}
    preds = [p for p, _ in pairs]
    golds = [g for _, g in pairs]
    valid = [(p, g) for p, g in pairs if p in classifier.LABELS]
    v_preds = [p for p, _ in valid]
    v_golds = [g for _, g in valid]
    return {
        "n_gold": len(pairs),
        "n_parse_fail": sum(1 for p, _ in pairs if p not in classifier.LABELS),
        "accuracy": float(accuracy_score(v_golds, v_preds)) if valid else 0.0,
        "accuracy_strict": sum(1 for p, g in pairs if p == g) / len(pairs),
        "macro_f1": float(f1_score(v_golds, v_preds, average="macro",
                                   labels=classifier.LABELS, zero_division=0)) if valid else 0.0,
        "weighted_f1": float(f1_score(v_golds, v_preds, average="weighted",
                                      labels=classifier.LABELS, zero_division=0)) if valid else 0.0,
        "per_class": classification_report(v_golds, v_preds, labels=classifier.LABELS,
                                           target_names=classifier.CLASS_NAMES, digits=4,
                                           zero_division=0) if valid else "",
        "confusion_matrix": confusion_matrix(v_golds, v_preds, labels=classifier.LABELS).tolist()
        if valid else None,
    }


def write_artifacts(records: list[dict], out: Path, *, mode: str, model: str,
                    thinking: str | None, elapsed: float, parallel: int = 0) -> dict:
    """Tulis predictions.jsonl, results.csv, report.txt (+png kalau ada gold)."""
    out.mkdir(parents=True, exist_ok=True)
    tag = f"{mode}shot"

    with open(out / f"predictions_{tag}.jsonl", "w", encoding="utf-8") as fh:
        for rec in records:
            fh.write(json.dumps(rec, ensure_ascii=False) + "\n")

    with open(out / f"results_{tag}.csv", "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(["idx", "label", "gold", "alasan", "latency_ms", "text"])
        for rec in records:
            w.writerow([rec["idx"], rec["pred"], rec.get("gold") or "",
                        rec.get("reason") or "", rec["latency_ms"], rec["text"]])

    m = compute_metrics(records)
    n_fail = sum(1 for r in records if r["pred"] not in classifier.LABELS)
    with open(out / f"report_{tag}.txt", "w", encoding="utf-8") as fh:
        fh.write(f"Prompt variant : {mode}-shot\n")
        fh.write(f"Model          : {model}\n")
        fh.write(f"response_format: json_object (DeepSeek API)\n")
        fh.write(f"Thinking       : {thinking or 'default server'}\n")
        if parallel:
            fh.write(f"Paralel        : 1 warm-up + sisa maks {parallel}\n")
        fh.write(f"Sampel         : {len(records)} (parse_fail={n_fail})\n")
        fh.write(f"Total waktu    : {elapsed:.1f}s ({elapsed / len(records):.1f}s/sampel)\n")
        u = usage_summary(records)
        if u:
            fh.write(f"Token          : in {u['input_miss']} (miss) + {u['input_hit']} (hit) · "
                     f"out {u['output']}\n")
            fh.write(f"Estimasi biaya : ${u['usd']} (harga peak deepseek-flash, bukan tagihan)\n")
        if not m.get("n_gold"):
            fh.write("Tanpa kolom gold — metrik akurasi tidak dihitung.\n")
        else:
            fh.write(f"Accuracy (valid):   {m['accuracy']:.4f}\n")
            fh.write(f"Accuracy (strict):  {m['accuracy_strict']:.4f}  [parse-fail=salah]\n")
            fh.write(f"Macro-F1:           {m['macro_f1']:.4f}\n")
            fh.write(f"Weighted-F1:        {m['weighted_f1']:.4f}\n\n")
            fh.write(m["per_class"])

    if m.get("confusion_matrix"):
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt

        cm = m["confusion_matrix"]
        fig, ax = plt.subplots(figsize=(6, 5))
        im = ax.imshow(cm, cmap="Blues")
        ax.set_xticks(range(5)); ax.set_yticks(range(5))
        ax.set_xticklabels(classifier.LABELS); ax.set_yticklabels(classifier.LABELS)
        ax.set_xlabel("Prediksi"); ax.set_ylabel("Label Emas")
        ax.set_title(f"Confusion Matrix — {tag} (acc={m['accuracy']:.3f})")
        for yi in range(5):
            for xi in range(5):
                ax.text(xi, yi, cm[yi][xi], ha="center", va="center",
                        color="white" if cm[yi][xi] > max(max(r) for r in cm) / 2 else "black")
        fig.colorbar(im); fig.tight_layout()
        fig.savefig(out / f"confusion_matrix_{tag}.png", dpi=120)
        plt.close(fig)

    return m


DEFAULT_CAP = 64         # batas request paralel setelah baris warm-up


async def run(rows: list[dict], out: Path, *, mode: str = "few", model: str = classifier.DEFAULT_MODEL,
              thinking: str | None = None, concurrency: int = DEFAULT_CAP,
              max_tokens: int = 4096, on_record=None) -> dict:
    """Klasifikasi semua baris. Baris pertama dikirim SENDIRIAN lalu ditunggu:
    itu mengisi KV-cache prompt di server DeepSeek, jadi sisa baris membayar
    harga cache-hit, bukan cache-miss (input ~50x lebih murah). Setelah itu
    baris sisanya dilepas paralel, dibatasi `concurrency`.
    """
    records: list[dict | None] = [None] * len(rows)
    done = 0
    t0 = time.time()
    cap = max(1, min(int(concurrency or DEFAULT_CAP), len(rows) or 1))
    sem = asyncio.Semaphore(cap)

    async with classifier.make_client() as client:
        async def one(row: dict):
            nonlocal done
            async with sem:
                rec = await classifier.classify(client, row["text"], mode=mode, model=model,
                                                thinking=thinking, max_tokens=max_tokens)
            rec = {"idx": row["idx"], **rec}
            if row.get("gold"):
                rec["gold"] = row["gold"]
            records[row["idx"]] = rec
            done += 1
            if on_record:
                await on_record(rec, done, len(rows))
            return rec

        # 1) warm-up: satu request, ditunggu sampai selesai
        await one(rows[0])
        # 2) sisanya serentak (dibatasi cap)
        await asyncio.gather(*(one(r) for r in rows[1:]))

    elapsed = time.time() - t0
    final = [r for r in records if r is not None]
    m = write_artifacts(final, out, mode=mode, model=model, thinking=thinking,
                        elapsed=elapsed, parallel=cap)
    return {"metrics": m, "elapsed_s": round(elapsed, 1), "n": len(final),
            "usage": usage_summary(final), "parallel": cap,
            "n_parse_fail": sum(1 for r in final if r["pred"] not in classifier.LABELS)}


async def _main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--csv", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--mode", choices=["few", "zero"], default="few")
    ap.add_argument("--model", default=classifier.DEFAULT_MODEL)
    ap.add_argument("--thinking", choices=["off", "low", "high", "max"], default=None)
    ap.add_argument("--concurrency", type=int, default=DEFAULT_CAP,
                    help=f"batas request paralel setelah warm-up 1 baris (default {DEFAULT_CAP})")
    ap.add_argument("--max-tokens", type=int, default=4096)
    ap.add_argument("--limit", type=int, default=0)
    args = ap.parse_args()

    rows = read_csv(args.csv)
    if args.limit:
        rows = rows[: args.limit]

    async def progress(rec, done, total):
        ok = "?" if not rec.get("gold") else ("OK" if rec["pred"] == rec["gold"] else "XX")
        print(f"  [{done:4d}/{total}] {ok} pred={rec['pred']:<10} "
              f"{rec['latency_ms']/1000:.1f}s {rec.get('error') or ''}", flush=True)

    print(f"[*] {len(rows)} baris | mode={args.mode} | model={args.model} | "
          f"thinking={args.thinking or 'default'} | concurrency={args.concurrency}")
    res = await run(rows, Path(args.out), mode=args.mode, model=args.model,
                    thinking=args.thinking, concurrency=args.concurrency,
                    max_tokens=args.max_tokens, on_record=progress)
    m = res["metrics"]
    print(f"\n[+] {res['n']} sampel, parse_fail={res['n_parse_fail']}, {res['elapsed_s']}s")
    if res.get("usage"):
        u = res["usage"]
        print(f"[+] Token in {u['input_miss']}+{u['input_hit']} hit | out {u['output']} | "
              f"est ${u['usd']}")
    if m.get("n_gold"):
        print(f"[+] Accuracy={m['accuracy']:.4f} | Macro-F1={m['macro_f1']:.4f} | "
              f"Weighted-F1={m['weighted_f1']:.4f}")
    print(f"[+] Output: {args.out}/")


if __name__ == "__main__":
    asyncio.run(_main())
