"""Tes inti yang murah dijalankan: rute, anggaran token, hapus sesi, berhenti, ulangi.

Jalankan dari akar proyek:
    ~/myenv/bin/python3 -m unittest discover -s tests -t . -v

Sengaja memakai stdlib unittest, tanpa dependensi tes tambahan.
"""
from __future__ import annotations

import asyncio
import json
import re
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from core import batch, classifier                      # noqa: E402
from web import app as webapp                           # noqa: E402


class RouteCoverageTest(unittest.TestCase):
    """Setiap rute yang dipanggil frontend harus ada di OpenAPI.

    Regresi nyata: menghapus fitur impor ikut menghapus POST /api/sessions,
    kirim pesan mati total dan tidak ada yang gagal saat build.
    """

    def test_semua_rute_frontend_ada(self):
        js = (ROOT / "web" / "static" / "app.js").read_text(encoding="utf-8")
        called = set(re.findall(r'(?:api|fetch)\(\s*[`"](/api/[^`"]*)[`"]', js))
        self.assertTrue(called, "tidak ada panggilan /api yang terdeteksi di app.js")

        declared = set(webapp.app.openapi()["paths"])
        param = re.compile(r"\$\{[^}]+\}")

        def shape(path: str) -> str:
            """Semua nama parameter disamakan jadi {p}, supaya bisa dibandingkan."""
            return re.sub(r"\{[^}]+\}", "{p}", param.sub("{p}", path))

        shapes = {shape(d) for d in declared}
        for path in sorted(called):
            self.assertIn(shape(path.split("?")[0]), shapes,
                          f"{path} tidak punya pasangan di OpenAPI: {sorted(declared)}")


class BudgetTest(unittest.TestCase):
    """Jawaban terpotong harus menaikkan anggaran, bukan memanen label dari pikiran."""

    def test_tangga_anggaran_sampai_131072(self):
        seen = []
        original = classifier._call

        async def fake_call(client, messages, model, budget, thinking, on_delta):
            seen.append(budget)
            if budget < 131072:
                # terpotong: reasoning menyebut C2, jawaban belum ada
                return "", "menimbang ... C2 ...", "length", 1.0, {"completion_tokens": budget}
            return '{"alasan": "Operasi: membangun-makna.", "label": "C3"}', "", "stop", 1.0, {}

        classifier._call = fake_call
        try:
            rec = asyncio.run(classifier.classify(object(), "teks", thinking="max"))
        finally:
            classifier._call = original

        self.assertEqual(seen, [32768, 65536, 131072])
        self.assertEqual(rec["pred"], "C3")
        self.assertTrue(rec["reason"])


class SessionTest(unittest.TestCase):
    """Hapus sesi lewat API harus benar-benar menghapus berkasnya."""

    def test_hapus_sesi_menghapus_berkas(self):
        from fastapi.testclient import TestClient

        client = TestClient(webapp.app)
        created = client.post("/api/sessions", json={"title": "uji hapus"})
        self.assertEqual(created.status_code, 200, created.text)
        session_id = created.json()["id"]
        path = webapp.SESSIONS / f"{session_id}.json"
        self.assertTrue(path.exists())

        self.assertEqual(client.delete(f"/api/sessions/{session_id}").status_code, 200)
        self.assertFalse(path.exists(), "berkas sesi masih ada setelah DELETE")


class BatchStopTest(unittest.TestCase):
    """should_stop melewati baris berikutnya dan tetap menulis hasil parsial."""

    def setUp(self):
        self.out = Path(tempfile.mkdtemp(prefix="coi-test-"))

    def tearDown(self):
        shutil.rmtree(self.out, ignore_errors=True)

    def _rows(self, n):
        return [{"idx": i, "text": f"postingan {i}", "gold": None} for i in range(n)]

    def test_berhenti_menulis_hasil_parsial(self):
        original = classifier.classify
        calls = {"n": 0}

        async def fake(client, text, **kw):
            calls["n"] += 1
            return {"text": text[:500], "pred": "C2", "reason": "Operasi: menyumbang-menyiarkan.",
                    "latency_ms": 10.0, "finish": "stop", "budget": 32768, "error": None,
                    "usage": None, "thinking_head": "", "answer_head": ""}

        classifier.classify = fake
        try:
            res = asyncio.run(batch.run(self._rows(5), self.out, thinking=None,
                                        should_stop=lambda: calls["n"] >= 1))
        finally:
            classifier.classify = original

        self.assertTrue(res["cancelled"])
        self.assertEqual(res["n"], 1, "hanya baris yang sudah jalan yang tercatat")
        saved = [json.loads(l) for l in
                 (self.out / "predictions_fewshot.jsonl").read_text(encoding="utf-8").splitlines()]
        self.assertEqual([r["idx"] for r in saved], [0])

    def test_ulang_menggabung_hasil_lama(self):
        original = classifier.classify

        async def fake(client, text, **kw):
            return {"text": text[:500], "pred": "C3", "reason": "Operasi: membangun-makna.",
                    "latency_ms": 10.0, "finish": "stop", "budget": 32768, "error": None,
                    "usage": None, "thinking_head": "", "answer_head": ""}

        base = [{"idx": 0, "text": "postingan 0", "pred": "PARSE_FAIL", "reason": None,
                 "answer_head": "",
                 "latency_ms": 1.0, "finish": "length", "budget": 131072, "error": None,
                 "usage": None, "gold": None, "thinking_head": ""}]
        classifier.classify = fake
        try:
            res = asyncio.run(batch.run(self._rows(3), self.out, thinking=None,
                                        base_records=base, should_stop=None))
        finally:
            classifier.classify = original

        self.assertFalse(res["cancelled"])
        saved = [json.loads(l) for l in
                 (self.out / "predictions_fewshot.jsonl").read_text(encoding="utf-8").splitlines()]
        self.assertEqual([r["idx"] for r in saved], [0, 1, 2], "baris lama dan baru digabung")
        self.assertEqual(saved[0]["pred"], "C3", "baris yang diulang memakai hasil baru")


class ClassDefsTest(unittest.TestCase):
    """Legenda kelas hanya boleh punya satu sumber: classifier.CLASS_DEFS."""

    def test_health_mengirim_definisi_kelas(self):
        from fastapi.testclient import TestClient

        data = TestClient(webapp.app).get("/api/health").json()
        self.assertEqual(data["class_defs"], classifier.CLASS_DEFS)
        self.assertNotIn("CLASS_DEFS = [", (ROOT / "web" / "static" / "app.js")
                         .read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
