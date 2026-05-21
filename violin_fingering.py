"""
violin_fingering.py
===================
Optimal violin fingering via dynamic programming.
"""

from __future__ import annotations
from dataclasses import dataclass, field
from typing import Optional
import math


OPEN_STRINGS: dict[str, int] = {
    "G": 55,
    "D": 62,
    "A": 69,
    "E": 76,
}

STRING_ORDER = ["G", "D", "A", "E"]

FINGER_OFFSETS = [0, 2, 3, 5]

POSITION_F1_OFFSET: dict = {
    "half": 1,
    1:  2,
    2:  4,
    3:  5,
    4:  7,
    5:  9,
    6:  10,
    7:  12,
    8:  14,
    9:  15,
    10: 17,
    11: 19,
    12: 20,
}

MAX_STRETCH = 5

POSITION_CONVENTION_COST: dict = {
    "half": 3.0,
    1:      0.0,
    2:      1.0,
    3:      0.0,
    4:      1.0,
    5:      0.0,
    6:      1.0,
    7:      0.0,
    8:      3.0,
    9:      3.0,
    10:     3.0,
    11:     6.0,
    12:     6.0,
}


@dataclass(frozen=True)
class Assignment:
    string: str
    pos: int
    finger: int

    @property
    def string_index(self) -> int:
        return STRING_ORDER.index(self.string)

    def __repr__(self):
        finger_label = "open" if self.finger == 0 else str(self.finger)
        pos_label = "-" if self.finger == 0 else str(self.pos)
        return f"{self.string}[pos={pos_label} f={finger_label}]"


@dataclass
class FingeredNote:
    midi_pitch: int
    duration: float
    is_rest: bool = False
    assignment: Optional[Assignment] = None

    def __repr__(self):
        if self.is_rest:
            return f"Rest(dur={self.duration})"
        return f"Note(midi={self.midi_pitch}, {self.assignment})"


def valid_assignments(midi_pitch: int, string_constraint: Optional[str] = None) -> list[Assignment]:
    results: list[Assignment] = []
    for string, open_p in OPEN_STRINGS.items():
        if string_constraint and string != string_constraint:
            continue
        if midi_pitch == open_p:
            results.append(Assignment(string, 0, 0))
        for pos, f1_offset in POSITION_F1_OFFSET.items():
            for finger, fng_offset in enumerate(FINGER_OFFSETS, start=1):
                if open_p + f1_offset + fng_offset == midi_pitch:
                    results.append(Assignment(string, pos, finger))
    return results


@dataclass
class CostWeights:
    string_crossing:  float = 10.0
    position_shift:   float = 3.0
    high_position:    float = 0.3
    pinky:            float = 1.0
    open_string:      float = -2.0
    unconventional:   float = 4.0


def transition_cost(a1: Assignment, a2: Assignment, weights: CostWeights) -> float:
    strings_crossed = abs(a1.string_index - a2.string_index)
    p1 = POSITION_F1_OFFSET.get(a1.pos, 0)
    p2 = POSITION_F1_OFFSET.get(a2.pos, 0)
    pos_shift = abs(p1 - p2)
    return (
        weights.string_crossing * strings_crossed
        + weights.position_shift * pos_shift
    )


def node_cost(a: Assignment, weights: CostWeights) -> float:
    if a.finger == 0:
        return weights.open_string
    real_pos   = POSITION_F1_OFFSET.get(a.pos, 0)
    convention = POSITION_CONVENTION_COST.get(a.pos, 0.0)
    return (
        weights.high_position  * real_pos
        + weights.unconventional * convention
        + weights.pinky          * (1 if a.finger == 4 else 0)
    )


def is_feasible_transition(a1: Assignment, a2: Assignment) -> bool:
    p1 = POSITION_F1_OFFSET.get(a1.pos, 0)
    p2 = POSITION_F1_OFFSET.get(a2.pos, 0)
    return abs(p1 - p2) <= 12


INF = math.inf


def _is_free_shift(a: Assignment) -> bool:
    return a.finger == 0


def solve(
    sequence: list[tuple[Optional[int], float]],
    weights: Optional[CostWeights] = None,
    string_constraints: Optional[list[Optional[str]]] = None,
) -> list[FingeredNote]:
    if weights is None:
        weights = CostWeights()
    if not sequence:
        return []

    N = len(sequence)
    rest_flags: list[bool] = []
    layers: list[list[Assignment]] = []
    all_assigns: list[Assignment] = []
    all_seen: set[Assignment] = set()

    for i, (midi_pitch, _) in enumerate(sequence):
        sc = string_constraints[i] if string_constraints else None
        if midi_pitch is None:
            rest_flags.append(True)
            layers.append([])
        else:
            rest_flags.append(False)
            assigns = valid_assignments(midi_pitch, sc)
            if not assigns:
                constraint_hint = f" (string_constraint='{sc}')" if sc else ""
                raise ValueError(
                    f"No valid assignment for MIDI pitch {midi_pitch}{constraint_hint}. "
                    f"Check the pitch is in violin range (G3–~E7)."
                )
            layers.append(assigns)
            for a in assigns:
                if a not in all_seen:
                    all_assigns.append(a)
                    all_seen.add(a)

    for i, is_rest in enumerate(rest_flags):
        if is_rest:
            layers[i] = all_assigns

    dp: dict[Assignment, float] = {
        a: (0.0 if rest_flags[0] else node_cost(a, weights))
        for a in layers[0]
    }
    back: list[dict[Assignment, Assignment]] = [{}]

    for i in range(1, N):
        new_dp: dict[Assignment, float] = {}
        new_back: dict[Assignment, Assignment] = {}

        for a2 in layers[i]:
            best_cost = INF
            best_prev = None

            for a1 in layers[i - 1]:
                rest_edge = rest_flags[i - 1] or rest_flags[i]
                open_edge = _is_free_shift(a1) or _is_free_shift(a2)

                if rest_edge:
                    t_cost = 0.0
                elif open_edge:
                    strings_crossed = abs(a1.string_index - a2.string_index)
                    t_cost = weights.string_crossing * strings_crossed
                else:
                    if not is_feasible_transition(a1, a2):
                        continue
                    t_cost = transition_cost(a1, a2, weights)

                n_cost = 0.0 if rest_flags[i] else node_cost(a2, weights)
                cost = dp.get(a1, INF) + t_cost + n_cost

                if cost < best_cost:
                    best_cost = cost
                    best_prev = a1

            new_dp[a2] = best_cost
            new_back[a2] = best_prev  # type: ignore

        dp = new_dp
        back.append(new_back)

    best_last = min(dp, key=lambda a: dp[a])
    path: list[Assignment] = [best_last]
    for i in range(N - 1, 0, -1):
        path.append(back[i][path[-1]])
    path.reverse()

    result = []
    for i, (assignment, (midi_pitch, duration)) in enumerate(zip(path, sequence)):
        result.append(FingeredNote(
            midi_pitch=midi_pitch or 0,
            duration=duration,
            is_rest=rest_flags[i],
            assignment=assignment,
        ))
    return result


NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


def midi_to_name(midi: int) -> str:
    name = NOTE_NAMES[midi % 12]
    octave = (midi // 12) - 1
    return f"{name}{octave}"


def load_from_musicxml(path: str) -> list[tuple[int, float]]:
    try:
        from music21 import converter
    except ImportError:
        raise ImportError("music21 is required: pip install music21")
    score = converter.parse(path)
    flat = score.parts[0].flat.notesAndRests
    sequence = []
    for element in flat:
        if element.isChord:
            midi = min(p.midi for p in element.pitches)
            sequence.append((midi, float(element.quarterLength)))
        elif element.isNote:
            sequence.append((element.pitch.midi, float(element.quarterLength)))
        elif element.isRest:
            sequence.append((None, float(element.quarterLength)))
    return sequence
