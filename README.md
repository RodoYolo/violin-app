# Violin Fingering Optimizer

A tool that computes **optimal left-hand fingerings** for a melody on the violin.
Given a sequence of notes, it decides which string, position, and finger to use for
each note so the passage is as comfortable and playable as possible — minimizing
awkward shifts, string crossings, and unidiomatic hand positions.

The core is a small optimization library (`violin_fingering.py`); a Django web app
wraps it in an interactive UI where you can pick scales, exercises, and full pieces,
tweak the cost weights, and even import MIDI files from [bitmidi.com](https://bitmidi.com).

## How it works

Each note can typically be played several ways (different string/position/finger
combinations). The optimizer models the melody as a layered graph — one layer of
candidate fingerings per note — and finds the lowest-cost path through it.

- **Node cost** scores how awkward a single fingering is: high positions, pinky use,
  unconventional positions, and poor vibrato candidates (open strings / pinky on long
  notes) cost more; open strings are rewarded.
- **Transition cost** scores the move between consecutive notes: string crossings and
  position shifts are penalized, staying in position is rewarded. Open strings and
  rests act as "free" windows where the hand can reposition at no cost.

Two interchangeable solvers produce the same globally optimal result:

| Solver | Method |
| --- | --- |
| `solve_dp` | Viterbi dynamic programming (left-to-right sweep), `O(N·|A|²)` |
| `solve_lp` | Min-cost flow MIP via SciPy `milp` (default; the constraint matrix is totally unimodular, so the LP relaxation is integral) |

All cost weights are tunable via the `CostWeights` dataclass.

## Project layout

```
violin_fingering.py    # standalone optimizer library (DP + LP solvers)
violinapp/             # Django project (settings, urls, wsgi)
fingering/             # Django app: views, templates, static assets, example data
songs/                 # source material for the bundled example pieces
manage.py
```

### Web endpoints

| Route | Description |
| --- | --- |
| `/` | Interactive UI: example scales/exercises/pieces, weight controls, results |
| `/api/solve/` | `POST` a note sequence + weights, returns fingerings and solver metrics |
| `/api/search/` | `GET` search bitmidi.com for MIDI files |
| `/api/import/` | `POST` a bitmidi URL, auto-selects the melody track and extracts a sequence |

## Setup

Requires Python 3.13+.

```bash
# (recommended) create and activate a virtualenv
python3 -m venv .venv
source .venv/bin/activate

# install dependencies
pip install -r requirements.txt

# run migrations and start the dev server
python manage.py migrate
python manage.py runserver
```

Then open http://127.0.0.1:8000/.

## Using the library directly

```python
from violin_fingering import solve, midi_to_name

# (midi_pitch, duration_in_quarter_beats); use None for a rest
sequence = [(55, 1.0), (57, 1.0), (59, 1.0), (60, 1.0), (62, 1.0)]

for note in solve(sequence):
    print(midi_to_name(note.midi_pitch), note.assignment)
```

You can also load a melody from MusicXML via `load_from_musicxml(path)`, constrain
notes to a specific string with `string_constraints`, and override any cost via
`CostWeights(...)`.

## Notes

- Violin range supported: roughly G3–E7 (MIDI 55–101).
- The `solve` alias points at the LP/MIP solver by default; swap to `solve_dp` for the
  dynamic-programming implementation — both return identical optimal fingerings.
