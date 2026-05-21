"""
Import script for Villoldo – El Choclo
=======================================
Source:  https://bitmidi.com/el-choclo-1-mid
         (direct: https://bitmidi.com/uploads/42918.mid)
Raw file: songs/el_choclo/raw/42918.mid
Output:  fingering/data_el_choclo.json

Run from the project root:
    python3 songs/el_choclo/import.py

Requires:  mido  (pip install mido)

Notes:
  - Type 0 MIDI (all channels in one track). Melody is on channel 4,
    GM program 48 (String Ensemble 1), pitch range MIDI 57-88.
  - Other channels: ch1=Acoustic Bass, ch2=Tango Accordion, ch5=Vibraphone,
    ch6=Piano (chords), ch9=Percussion.
  - Good dynamic variation: velocity 80-127 (mf to ff), mean 109.4.
"""

import json
import mido
from pathlib import Path

RAW_MIDI       = Path(__file__).parent / "raw" / "42918.mid"
OUTPUT         = Path(__file__).parent.parent.parent / "fingering" / "data_el_choclo.json"

MELODY_CHANNEL = 4     # String Ensemble (GM 48), the melodic violin-range line
QUANTIZE_GRID  = 0.25  # 1/16 note in quarter-note units
REST_THRESHOLD = 0.1   # gaps shorter than this fraction of a beat are ignored


def quantize(ticks: int, tpb: int) -> float:
    q = round(ticks / tpb / QUANTIZE_GRID) * QUANTIZE_GRID
    return max(QUANTIZE_GRID, q)


def extract_notes(track, tpb: int, channel: int) -> list[dict]:
    """Return sorted list of {start_tick, end_tick, pitch, velocity} for one channel."""
    events = []
    abs_tick = 0
    for msg in track:
        abs_tick += msg.time
        if msg.type in ("note_on", "note_off") and msg.channel == channel:
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

    notes = extract_notes(mid.tracks[0], tpb, MELODY_CHANNEL)
    sequence = build_sequence(notes, tpb)

    data = {
        "label": "Villoldo – El Choclo",
        "bpm": 120,
        "sequence": sequence,
    }

    OUTPUT.write_text(json.dumps(data))
    print(f"Written {len(sequence)} items ({sum(1 for n in sequence if n[0] is not None)} notes, "
          f"{sum(1 for n in sequence if n[0] is None)} rests) to {OUTPUT}")


if __name__ == "__main__":
    main()
