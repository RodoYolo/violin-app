import concurrent.futures
import json
import math
import os
import re
import sys
import tempfile
from django.utils.safestring import mark_safe

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import mido
import requests as _req
from bs4 import BeautifulSoup

from django.shortcuts import render
from django.http import JsonResponse
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_http_methods

from violin_fingering import (
    solve, CostWeights, FingeredNote, midi_to_name,
    POSITION_F1_OFFSET, STRING_ORDER, valid_assignments,
)


def _load_json_example(filename):
    path = os.path.join(os.path.dirname(__file__), filename)
    with open(path) as f:
        return json.load(f)

EXAMPLES = {
    "g_major": {
        "label": "G Major Scale",
        "sequence": [
            [55, 1.0], [57, 1.0], [59, 1.0], [60, 1.0],
            [62, 1.0], [64, 1.0], [66, 1.0], [67, 1.0],
        ],
    },
    "open_shift": {
        "label": "Open String Shift (G4 → open A → D6)",
        "sequence": [
            [67, 1.0], [67, 1.0], [69, 1.0],
            [86, 1.0], [88, 1.0], [86, 1.0],
        ],
    },
    "rest_shift": {
        "label": "Rest as Shift Window (low → rest → high)",
        "sequence": [
            [64, 1.0], [66, 1.0], [67, 1.0],
            [None, 2.0],
            [88, 1.0], [86, 1.0], [84, 1.0],
        ],
    },
    "d_major": {
        "label": "D Major Scale",
        "sequence": [
            [62, 1.0], [64, 1.0], [66, 1.0], [67, 1.0],
            [69, 1.0], [71, 1.0], [73, 1.0], [74, 1.0],
        ],
    },
    "a_major": {
        "label": "A Major Scale",
        "sequence": [
            [69, 1.0], [71, 1.0], [73, 1.0], [74, 1.0],
            [76, 1.0], [78, 1.0], [80, 1.0], [81, 1.0],
        ],
    },
    "c_major": {
        "label": "C Major Scale",
        "sequence": [
            [60, 1.0], [62, 1.0], [64, 1.0], [65, 1.0],
            [67, 1.0], [69, 1.0], [71, 1.0], [72, 1.0],
        ],
    },
    "twinkle": {
        "label": "Twinkle Twinkle (D major, open D)",
        # D4=62 E4=64 F#4=66 G4=67 A4=69 B4=71
        "sequence": [
            [62, 1.0], [62, 1.0], [69, 1.0], [69, 1.0], [71, 1.0], [71, 1.0], [69, 2.0],
            [67, 1.0], [67, 1.0], [66, 1.0], [66, 1.0], [64, 1.0], [64, 1.0], [62, 2.0],
            [69, 1.0], [69, 1.0], [67, 1.0], [67, 1.0], [66, 1.0], [66, 1.0], [64, 2.0],
            [69, 1.0], [69, 1.0], [67, 1.0], [67, 1.0], [66, 1.0], [66, 1.0], [64, 2.0],
            [62, 1.0], [62, 1.0], [69, 1.0], [69, 1.0], [71, 1.0], [71, 1.0], [69, 2.0],
            [67, 1.0], [67, 1.0], [66, 1.0], [66, 1.0], [64, 1.0], [64, 1.0], [62, 2.0],
        ],
    },
    "vivaldi_summer": _load_json_example("data_vivaldi_summer.json"),
    "czardas": _load_json_example("data_czardas.json"),
    "el_choclo": _load_json_example("data_el_choclo.json"),
    "merry_go_round": _load_json_example("data_merry_go_round.json"),
}

EXAMPLE_GROUPS = [
    {
        "label": "Scales",
        "cols": 2,
        "keys": ["g_major", "d_major", "a_major", "c_major"],
    },
    {
        "label": "Exercises",
        "cols": 1,
        "keys": ["open_shift", "rest_shift", "twinkle"],
    },
    {
        "label": "Pieces",
        "cols": 1,
        "keys": ["vivaldi_summer", "czardas", "el_choclo", "merry_go_round"],
    },
]


def index(request):
    groups = [
        {
            "label": g["label"],
            "cols":  g["cols"],
            "items": [(k, EXAMPLES[k]) for k in g["keys"]],
        }
        for g in EXAMPLE_GROUPS
    ]
    return render(request, "fingering/index.html", {
        "examples": EXAMPLES,
        "examples_json": mark_safe(json.dumps(EXAMPLES)),
        "example_groups": groups,
    })


@csrf_exempt
@require_http_methods(["POST"])
def solve_view(request):
    try:
        data = json.loads(request.body)
        raw_seq = data.get("sequence", [])
        w = data.get("weights", {})

        sequence = []
        string_constraints = []
        for item in raw_seq:
            pitch = item[0]
            dur = float(item[1])
            sc = item[2] if len(item) > 2 else None
            sequence.append((None if pitch is None else int(pitch), dur))
            string_constraints.append(sc if sc else None)

        weights = CostWeights(
            string_crossing=float(w.get("string_crossing", 10.0)),
            position_shift=float(w.get("position_shift", 3.0)),
            high_position=float(w.get("high_position", 0.3)),
            pinky=float(w.get("pinky", 1.0)),
            open_string=float(w.get("open_string", -2.0)),
            unconventional=float(w.get("unconventional", 4.0)),
        )

        fingered = solve(sequence, weights, string_constraints)
        result = _serialize(fingered, string_constraints)

        # ── Optimization problem metrics ─────────────────────────────
        # Decision variables: 1 per note (categorical).
        # Lattice nodes: Σ |Aᵢ| — the total number of DP states.
        # For rests, |Aᵢ| equals the union of all assignments seen so far
        # (the rest layer is the union of feasible assignments).
        n_vars = len(sequence)
        layer_sizes = []
        all_assigns_seen = set()
        for j, (pitch, _) in enumerate(sequence):
            sc = string_constraints[j] if string_constraints else None
            if pitch is None:
                layer_sizes.append(len(all_assigns_seen))
            else:
                assigns = valid_assignments(pitch, sc)
                layer_sizes.append(len(assigns))
                all_assigns_seen.update(assigns)
        lattice_nodes = sum(layer_sizes)
        avg_branching = (lattice_nodes / max(n_vars, 1)) if n_vars else 0
        max_branching = max(layer_sizes) if layer_sizes else 0
        # Viterbi edges: each layer's |A| × prev layer's |A| (worst case)
        dp_edges = sum(
            layer_sizes[i] * layer_sizes[i - 1] for i in range(1, len(layer_sizes))
        )

        opt = {
            "n_variables":     n_vars,
            "lattice_nodes":   lattice_nodes,
            "dp_edges":        dp_edges,
            "avg_branching":   round(avg_branching, 2),
            "max_branching":   max_branching,
            "hard_constraints": 2,   # pitch match, max shift
            "soft_terms":       6,   # string_crossing, pos_shift, high_pos, pinky, open_string, unconventional
        }

        return JsonResponse({"ok": True, "result": result, "opt": opt})

    except Exception as e:
        return JsonResponse({"ok": False, "error": str(e)}, status=400)


def _serialize(fingered: list[FingeredNote], string_constraints: list = None) -> list[dict]:
    out = []
    prev = None
    prev_free = False

    for i, fn in enumerate(fingered):
        a = fn.assignment
        if fn.is_rest:
            out.append({
                "index": i,
                "is_rest": True,
                "duration": fn.duration,
                "note_name": "REST",
                "string": None,
                "pos": None,
                "pos_label": None,
                "finger": None,
                "string_index": None,
                "flags": ["free to shift"],
            })
            prev = a
            prev_free = True
            continue

        note_name = midi_to_name(fn.midi_pitch)
        is_open = a.finger == 0
        flags = []

        if prev is not None and not prev_free:
            if prev.string != a.string:
                flags.append("string crossing")
            p1 = POSITION_F1_OFFSET.get(prev.pos, 0)
            p2 = POSITION_F1_OFFSET.get(a.pos, 0)
            shift = p2 - p1
            if shift != 0:
                flags.append(f"shift {shift:+d} semitones")
        elif prev is not None and prev_free:
            p1 = POSITION_F1_OFFSET.get(prev.pos, 0)
            p2 = POSITION_F1_OFFSET.get(a.pos, 0)
            shift = p2 - p1
            if shift != 0:
                flags.append(f"shifted during free ({shift:+d})")

        if is_open:
            flags.append("open string — free shift next")

        sc = string_constraints[i] if string_constraints else None
        if sc:
            flags.append(f"sul {sc}")

        pos_label = str(a.pos) if a.finger != 0 else "—"

        out.append({
            "index": i,
            "is_rest": False,
            "midi_pitch": fn.midi_pitch,
            "duration": fn.duration,
            "note_name": note_name,
            "string": a.string,
            "pos": a.pos,
            "pos_label": pos_label,
            "finger": a.finger,
            "string_index": STRING_ORDER.index(a.string),
            "is_open": is_open,
            "string_constraint": sc,
            "flags": flags,
        })

        prev = a
        prev_free = is_open

    return out


# ── Bitmidi search & on-demand import ────────────────────────────────────────

_BITMIDI_HEADERS = {"User-Agent": "Mozilla/5.0"}

# GM program → priority score for violin-suitability
_PROGRAM_PRIORITY = {
    40: 10, 41: 8, 42: 7, 43: 6,          # violin, viola, cello, contrabass
    44: 5, 45: 5,                           # tremolo/pizzicato strings
    48: 4, 49: 4, 50: 3, 51: 3,            # string ensemble, synth strings
}
_VIOLIN_RANGE = range(55, 101)             # G3 – E7
_QUANTIZE     = 0.25
_REST_THRESH  = 0.1


def _auto_select_track(mid):
    """Return (track_index, channel_or_None) for the best melody track."""
    def _score(note_list, programs):
        if len(note_list) < 10:
            return -1
        pri   = max((_PROGRAM_PRIORITY.get(p, 0) for p in programs), default=0)
        ratio = sum(1 for n in note_list if n in _VIOLIN_RANGE) / len(note_list)
        return pri * 10 + ratio * 10 + math.log(len(note_list) + 1)

    if mid.type == 0:
        ch_programs, ch_notes = {}, {}
        for m in mid.tracks[0]:
            if m.type == "program_change":
                ch_programs.setdefault(m.channel, set()).add(m.program)
            elif m.type == "note_on" and m.velocity > 0:
                ch_notes.setdefault(m.channel, []).append(m.note)
        best_ch = max(ch_notes, key=lambda c: _score(ch_notes[c], ch_programs.get(c, set())), default=0)
        return 0, best_ch

    best_idx, best_score = None, -1
    for i, track in enumerate(mid.tracks):
        programs, notes = set(), []
        for m in track:
            if m.type == "program_change":
                programs.add(m.program)
            elif m.type == "note_on" and m.velocity > 0:
                notes.append(m.note)
        s = _score(notes, programs)
        if s > best_score:
            best_score, best_idx = s, i
    return best_idx, None


def _detect_bpm(mid):
    tempos, abs_tick = [], 0
    for m in (mid.tracks[0] if mid.tracks else []):
        abs_tick += m.time
        if m.type == "set_tempo":
            tempos.append((abs_tick, m.tempo))
    if not tempos:
        return 120
    best_tempo, best_dur = tempos[0][1], 0
    for i, (tick, tempo) in enumerate(tempos):
        next_tick = tempos[i + 1][0] if i + 1 < len(tempos) else abs_tick + 1
        if (next_tick - tick) > best_dur:
            best_dur, best_tempo = next_tick - tick, tempo
    return max(20, min(300, round(60_000_000 / best_tempo)))


def _extract_and_build(track, tpb, channel=None):
    events, abs_tick = [], 0
    for m in track:
        abs_tick += m.time
        if m.type in ("note_on", "note_off") and (channel is None or m.channel == channel):
            events.append((abs_tick, m.type, m.note, m.velocity))
    active, notes = {}, []
    for tick, typ, note, vel in events:
        if typ == "note_on" and vel > 0:
            active[note] = (tick, vel)
        elif typ in ("note_off",) or (typ == "note_on" and vel == 0):
            if note in active:
                start, sv = active.pop(note)
                notes.append({"start_tick": start, "end_tick": tick, "pitch": note, "velocity": sv})
    notes.sort(key=lambda n: n["start_tick"])
    if not notes:
        return []
    sequence, prev_end = [], notes[0]["start_tick"]
    for n in notes:
        gap = n["start_tick"] - prev_end
        if gap > tpb * _REST_THRESH:
            sequence.append([None, max(_QUANTIZE, round(gap / tpb / _QUANTIZE) * _QUANTIZE)])
        dur = max(_QUANTIZE, round((n["end_tick"] - n["start_tick"]) / tpb / _QUANTIZE) * _QUANTIZE)
        sequence.append([n["pitch"], dur])
        prev_end = n["end_tick"]
    return sequence


def _parse_store(html):
    """Extract window.initStore JSON from bitmidi HTML (client-side rendered)."""
    m = re.search(r'window\.initStore\s*=\s*(\{)', html)
    if not m:
        return {}
    start = m.start(1)
    depth, end = 0, start
    for end, ch in enumerate(html[start:], start):
        if ch == '{': depth += 1
        elif ch == '}':
            depth -= 1
            if depth == 0:
                break
    return json.loads(html[start:end + 1])


def _fetch_search_page(q, page):
    """
    Page 1: fetch without page param → store key "0".
    Page N>1: fetch with page=N → store key str(N).
    Returns (results, total, page_total).
    """
    params = {"q": q} if page == 1 else {"q": q, "page": page}
    store_key = "0" if page == 1 else str(page)

    resp = _req.get("https://bitmidi.com/search", params=params,
                    timeout=8, headers=_BITMIDI_HEADERS)
    store = _parse_store(resp.text)

    search_data = store.get("views", {}).get("search", {}).get(q, {})
    slugs      = search_data.get(store_key, [])
    total      = search_data.get("total", 0)
    page_total = search_data.get("pageTotal", 1)

    results = []
    for slug in slugs:
        title = re.sub(r"-mid(?:-\d+)?$", "", slug).replace("-", " ").title()
        results.append({"title": title, "url": f"https://bitmidi.com/{slug}"})

    return results, total, page_total


@require_http_methods(["GET"])
def search_view(request):
    q = request.GET.get("q", "").strip()
    if not q:
        return JsonResponse({"ok": False, "error": "empty query"}, status=400)
    try:
        page1_results, total, page_total = _fetch_search_page(q, 1)
        pages_to_fetch = min(page_total, 2)

        all_results = list(page1_results)
        if pages_to_fetch > 1:
            with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
                futures = [pool.submit(_fetch_search_page, q, p) for p in range(2, pages_to_fetch + 1)]
                for f in concurrent.futures.as_completed(futures):
                    page_results, _, _ = f.result()
                    all_results.extend(page_results)

        seen, unique = set(), []
        for r in all_results:
            if r["url"] not in seen:
                seen.add(r["url"])
                unique.append(r)

        return JsonResponse({"ok": True, "results": unique, "total": total})
    except Exception as e:
        return JsonResponse({"ok": False, "error": str(e)}, status=500)


@csrf_exempt
@require_http_methods(["POST"])
def import_view(request):
    try:
        body      = json.loads(request.body)
        page_url  = body.get("url", "").strip()
        label     = body.get("title", "").strip() or "Imported"

        page_resp = _req.get(page_url, timeout=8, headers=_BITMIDI_HEADERS)
        soup      = BeautifulSoup(page_resp.text, "html.parser")
        dl_link   = soup.find("a", href=re.compile(r"^/uploads/.*\.mid$", re.I))
        if not dl_link:
            return JsonResponse({"ok": False, "error": "No MIDI download link found"}, status=400)

        midi_bytes = _req.get(f"https://bitmidi.com{dl_link['href']}",
                              timeout=15, headers=_BITMIDI_HEADERS).content

        with tempfile.NamedTemporaryFile(suffix=".mid", delete=False) as f:
            f.write(midi_bytes)
            tmp = f.name
        try:
            mid = mido.MidiFile(tmp)
        finally:
            os.unlink(tmp)

        track_idx, channel = _auto_select_track(mid)
        if track_idx is None:
            return JsonResponse({"ok": False, "error": "No suitable melody track found"}, status=400)

        sequence = _extract_and_build(mid.tracks[track_idx], mid.ticks_per_beat, channel)

        # Drop notes outside the solver's violin range (G3=55 – E7=101); keep rests as-is
        sequence = [item for item in sequence if item[0] is None or 55 <= item[0] <= 101]

        note_count = sum(1 for item in sequence if item[0] is not None)
        if note_count < 5:
            return JsonResponse({"ok": False, "error": "Too few notes in detected track"}, status=400)

        return JsonResponse({
            "ok": True, "label": label, "bpm": _detect_bpm(mid),
            "sequence": sequence, "note_count": note_count,
        })
    except Exception as e:
        return JsonResponse({"ok": False, "error": str(e)}, status=500)
