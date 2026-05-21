"""
Import script for Vivaldi – The Four Seasons, Summer III. Presto
=================================================================
Source:  https://bitmidi.com/the-four-seasons-summer-3rd-movement-mid
         (direct: https://bitmidi.com/uploads/102473.mid)
Raw file: songs/vivaldi_summer/raw/102473.mid
Output:  fingering/data_vivaldi_summer.json

Run from the project root:
    python3 songs/vivaldi_summer/import.py

Requires:  mido  (pip install mido)
"""

import json
import mido
from pathlib import Path

RAW_MIDI   = Path(__file__).parent / "raw" / "102473.mid"
OUTPUT     = Path(__file__).parent.parent.parent / "fingering" / "data_vivaldi_summer.json"

VIOLIN_TRACK_INDEX = 6   # track named 'solovln', GM program 83 (synth strings)
QUANTIZE_GRID      = 0.25  # 1/16 note in quarter-note units
REST_THRESHOLD     = 0.1   # gaps shorter than this fraction of a beat are ignored

# No string constraints for this piece.
# Note: the MIDI has flat velocity (90) throughout — no dynamics are encoded.
# Written dynamics from the score (f, ff, p echo passages) are documented in
# metadata.json but are not reflected in the MIDI data.


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
    """Convert note list to [[pitch, dur] | [null, dur]] sequence."""
    sequence = []
    prev_end = notes[0]["start_tick"]

    for note in notes:
        start, end, pitch = note["start_tick"], note["end_tick"], note["pitch"]

        gap = start - prev_end
        if gap > tpb * REST_THRESHOLD:
            sequence.append([None, quantize(gap, tpb)])

        sequence.append([pitch, quantize(end - start, tpb)])
        prev_end = end

    return sequence


def main():
    mid = mido.MidiFile(str(RAW_MIDI))
    tpb = mid.ticks_per_beat

    notes = extract_notes(mid.tracks[VIOLIN_TRACK_INDEX], tpb)
    sequence = build_sequence(notes, tpb)

    data = {
        "label": "Vivaldi – Summer (Presto, III)",
        "bpm": 145,
        "sequence": sequence,
    }

    OUTPUT.write_text(json.dumps(data))
    print(f"Written {len(sequence)} items ({sum(1 for n in sequence if n[0] is not None)} notes, "
          f"{sum(1 for n in sequence if n[0] is None)} rests) to {OUTPUT}")


if __name__ == "__main__":
    main()
