"""
Import script for Monti – Csárdás
===================================
Source:  https://bitmidi.com/czardas-mid  (direct: https://bitmidi.com/uploads/26764.mid)
Raw file: songs/czardas/raw/26764.mid
Output:  fingering/data_czardas.json

Run from the project root:
    python3 songs/czardas/import.py

Requires:  mido  (pip install mido)
"""

import json
import mido
from pathlib import Path

RAW_MIDI   = Path(__file__).parent / "raw" / "26764.mid"
OUTPUT     = Path(__file__).parent.parent.parent / "fingering" / "data_czardas.json"

VIOLIN_TRACK_INDEX = 2   # track named 'Violin', GM program 48 (string ensemble)
QUANTIZE_GRID      = 0.25  # 1/16 note in quarter-note units
REST_THRESHOLD     = 0.1   # gaps shorter than this fraction of a beat are ignored

# Sul G hard constraint:
# The opening Lento (notes 0-55 of the violin part, ticks 1500-5490) is marked
# "Sul G" in the score — the entire passage must be played on the G string.
# All pitches in this range (max MIDI 70 / Bb4) are reachable on the G string.
SUL_G_END_TICK = 5490


def quantize(ticks: int, tpb: int) -> float:
    q = round(ticks / tpb / QUANTIZE_GRID) * QUANTIZE_GRID
    return max(QUANTIZE_GRID, q)


def extract_notes(track, tpb: int) -> list[dict]:
    """Return sorted list of {start_tick, end_tick, pitch, velocity}."""
    events = []
    abs_tick = 0
    for msg in track:
        abs_tick += msg.time
        if msg.type in ("note_on", "note_off"):
            events.append((abs_tick, msg.type, msg.note, msg.velocity))

    active: dict[int, tuple[int, int]] = {}
    notes = []
    for tick, typ, note, vel in events:
        if typ == "note_on" and vel > 0:
            active[note] = (tick, vel)
        elif typ == "note_off" or (typ == "note_on" and vel == 0):
            if note in active:
                start_tick, start_vel = active.pop(note)
                notes.append({
                    "start_tick": start_tick,
                    "end_tick": tick,
                    "pitch": note,
                    "velocity": start_vel,
                })
    notes.sort(key=lambda n: n["start_tick"])
    return notes


def build_sequence(notes: list[dict], tpb: int) -> list[list]:
    """
    Convert note list to [[pitch, dur] | [pitch, dur, string_constraint] | [null, dur]] sequence.

    String constraints:
      - "G" on notes whose end_tick <= SUL_G_END_TICK  (Sul G marking)
    """
    sequence = []
    prev_end = notes[0]["start_tick"]

    for note in notes:
        start, end, pitch = note["start_tick"], note["end_tick"], note["pitch"]

        gap = start - prev_end
        if gap > tpb * REST_THRESHOLD:
            sequence.append([None, quantize(gap, tpb)])

        dur = quantize(end - start, tpb)
        is_sul_g = end <= SUL_G_END_TICK + tpb * 0.1  # small tolerance

        if is_sul_g:
            sequence.append([pitch, dur, "G"])
        else:
            sequence.append([pitch, dur])

        prev_end = end

    return sequence


def main():
    mid = mido.MidiFile(str(RAW_MIDI))
    tpb = mid.ticks_per_beat

    notes = extract_notes(mid.tracks[VIOLIN_TRACK_INDEX], tpb)
    sequence = build_sequence(notes, tpb)

    data = {
        "label": "Monti – Csárdás",
        "bpm": 64,
        "sequence": sequence,
    }

    OUTPUT.write_text(json.dumps(data))
    print(f"Written {len(sequence)} items ({sum(1 for n in sequence if n[0] is not None)} notes, "
          f"{sum(1 for n in sequence if n[0] is None)} rests) to {OUTPUT}")
    sul_g = sum(1 for n in sequence if len(n) == 3 and n[2] == "G")
    print(f"Sul G constrained notes: {sul_g}")


if __name__ == "__main__":
    main()
