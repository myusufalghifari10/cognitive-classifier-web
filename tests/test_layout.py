"""Geometri tata letak sempit: judul tidak boleh tertimpa rail, isi tidak boleh
menggulir di belakangnya.

Angka di CSS adalah sihir yang mudah basi: saat #rail-new ditambahkan ke rail,
`padding-left` topbar tidak ikut diperbarui dan judul tertimpa 36px. Tes ini
menghitung ulang dari nilai CSS yang benar-benar dipakai, jadi perubahan ikon
atau gap akan langsung ketahuan.
"""
from __future__ import annotations

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CSS = (ROOT / "web" / "static" / "app.css").read_text(encoding="utf-8")
HTML = (ROOT / "web" / "static" / "index.html").read_text(encoding="utf-8")


def px(token: str) -> int:
    return int(re.search(rf"{re.escape(token)}:\s*(\d+)px", CSS).group(1))


def mobile_block() -> str:
    """Isi @media (max-width: 900px) { ... } di akhir berkas."""
    i = CSS.index("@media (max-width: 900px)")
    depth, j = 0, CSS.index("{", i)
    for k in range(j, len(CSS)):
        if CSS[k] == "{":
            depth += 1
        elif CSS[k] == "}":
            depth -= 1
            if depth == 0:
                return CSS[j:k]
    raise AssertionError("blok media 900px tidak tertutup")


class RailGeometryTest(unittest.TestCase):
    def test_judul_tidak_tertimpa_rail(self):
        block = mobile_block()
        icon = int(re.search(r"\.rail-logo, \.rail-pill \.icon-btn \{ width: (\d+)px", block).group(1))

        # Tombol di dalam pill, dikurangi yang disembunyikan di layar sempit.
        pill_html = HTML[HTML.index('<div class="rail-pill">'):HTML.index("</div>", HTML.index('<div class="rail-pill">'))]
        tombol = re.findall(r'id="(rail-[a-z]+)"', pill_html)
        disembunyikan = set(re.findall(r"#(rail-[a-z]+) \{ display: none; \}", block))
        terlihat = [t for t in tombol if t not in disembunyikan]
        self.assertTrue(terlihat, "tidak ada tombol rail yang tampil")

        pill_pad = px("--space-2xs")
        pill = len(terlihat) * icon + px("--space-3xs") + 2 * pill_pad
        rail_kanan = 16 + icon + px("--space-xs") + pill

        padding = int(re.search(r"\.shell\.collapsed \.topbar \{\s*padding-left: (\d+)px", block).group(1))
        self.assertGreaterEqual(
            padding, rail_kanan,
            f"padding-left {padding}px < tepi kanan rail {rail_kanan}px "
            f"(tombol terlihat: {terlihat}) - judul akan tertimpa")

    def test_isi_tidak_menggulir_di_belakang_rail(self):
        block = mobile_block()
        icon = int(re.search(r"\.rail-logo, \.rail-pill \.icon-btn \{ width: (\d+)px", block).group(1))
        rail_bawah = 16 + icon
        setinggi = int(re.search(r"min-height: (\d+)px", block).group(1))
        self.assertGreaterEqual(
            setinggi, rail_bawah,
            f"topbar {setinggi}px < dasar rail {rail_bawah}px - isi thread "
            "akan lewat di belakang tombol rail")


if __name__ == "__main__":
    unittest.main()
