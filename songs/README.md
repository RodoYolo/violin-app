# Song Imports

This directory holds the raw source files and full import documentation for every
piece in the app.  Nothing in here is generated — it is the ground truth.

---

## Directory layout

```
songs/
  <piece>/
    raw/          raw source file exactly as downloaded (MIDI, MusicXML, …)
    metadata.json full musical + source metadata (see schema below)
    import.py     the exact script used to produce fingering/data_<piece>.json
```

---

## How to re-run an import

```bash
# from project root
python3 songs/<piece>/import.py
```

The script reads from `songs/<piece>/raw/` and overwrites `fingering/data_<piece>.json`.
It must be fully reproducible — running it twice produces identical output.

---

## metadata.json schema

Every `metadata.json` must contain:

| field | description |
|---|---|
| `title` | Full title of the piece |
| `composer` | Composer name |
| `source.url` | Page URL where the file was found |
| `source.upload_path` | Direct download URL |
| `source.downloaded` | ISO date (YYYY-MM-DD) |
| `source.original_filename` | Filename as downloaded |
| `source.sha256` | SHA-256 of the raw file — use to verify integrity |
| `midi_file.type` | MIDI type (0/1/2) |
| `midi_file.ticks_per_beat` | Timing resolution |
| `midi_file.time_signature` | As written in the MIDI |
| `midi_file.key_signature_midi` | Key as the MIDI file reports it (may differ from sounding key) |
| `midi_file.tempo_map` | Full list of `{tick, tempo_us, bpm}` — every tempo change |
| `midi_file.tracks` | Per-track summary: name, GM program, note count, pitch range, velocity range/mean |
| `musical_notes.actual_key` | Sounding key (overrides MIDI metadata when wrong) |
| `musical_notes.time_signature` | Per-section if it changes |
| `musical_notes.sections` | Array of sections with name, tick range, note index range, description, and any performance markings (Sul G, con sordino, harmonics, etc.) |
| `musical_notes.dynamics` | Velocity range and mean per extracted track; any written dynamics from the score |
| `conversion.extracted_track` | Which MIDI track was used |
| `conversion.quantize_grid` | Quantisation grid in quarter-note units |
| `conversion.rest_threshold_beats` | Minimum gap to insert a rest |
| `conversion.string_constraints` | Any hard string constraints applied (Sul G, Sul D, etc.) with tick/note ranges |
| `conversion.output_format` | Description of the JSON array format |
| `conversion.script` | Path to the import script |
| `conversion.output_file` | Path to the generated JSON |
| `violin_notes` | Full per-note array `{start_tick, end_tick, pitch, velocity}` for the extracted track — preserves all dynamics before quantisation |

---

## Pieces

### Monti – Csárdás

| | |
|---|---|
| **File** | `songs/czardas/` |
| **Output** | `fingering/data_czardas.json` |
| **Source** | https://bitmidi.com/czardas-mid |
| **Direct URL** | https://bitmidi.com/uploads/26764.mid |
| **Downloaded** | 2026-05-21 |
| **SHA-256** | `7c3a5391b026bc67209851200661c1a7db7e9a91402269c8ec05e6973a12eec0` |
| **MIDI sequencer** | juliocezar@mps.com.br |
| **Extracted track** | Track 2 "Violin" (GM program 48) |

**Sections:**

| Section | Ticks | Notes | Key | Tempo | Notes |
|---|---|---|---|---|---|
| Lento | 1500–5490 | 0–55 | Bb minor | ~56–70 BPM | **Sul G** — full section on G string |
| Transition/Cadenza | 5520–6480 | 56–74 | — | variable | Ascending scale run out of Sul G range |
| Vivace / Friss | 6480–end | 75–1007 | Bb major | 100–132 BPM | Fast 16th-note dance; accelerando at end |

**Dynamics (violin track):**
- Velocity range: 73–119 (roughly mp to ff)
- Velocity mean: 93.5 (~mf/f)
- Sul G Lento: generally mp–mf
- Friss: f–ff, increasing toward end

**Performance markings captured:**
- `"G"` string constraint on all 56 Sul G notes (enforced as a hard constraint in the solver)

**Conversion parameters:**
- Quantise grid: 1/16 note (0.25 quarter notes)
- Rest threshold: 10% of a beat
- All per-note velocities stored in `metadata.json → violin_notes`

---

### Vivaldi – The Four Seasons, Summer III. Presto

| | |
|---|---|
| **File** | `songs/vivaldi_summer/` |
| **Output** | `fingering/data_vivaldi_summer.json` |
| **Source** | https://bitmidi.com/the-four-seasons-summer-3rd-movement-mid |
| **Direct URL** | https://bitmidi.com/uploads/102473.mid |
| **Downloaded** | 2026-05-21 |
| **SHA-256** | `f6f94498360e78540e60d0f79235d928af810d25755b4682d8a5769021ddcb8a` |
| **MIDI sequencer** | Unknown (copyright tag: UnAuthored) |
| **Extracted track** | Track 6 "solovln" (GM program 83) |

**Sections:**

| Section | Notes | Key | Tempo | Notes |
|---|---|---|---|---|
| Storm / tremolo theme | 0–~200 | G minor | 120 BPM (3/4) | Repeated-note tremolo on open strings, melodic fragments |
| Solo passages | ~200–1394 | G minor | 120 BPM | Rapid scales and arpeggios reaching A6 (MIDI 93) |

**Dynamics (violin track):**
- Velocity range: 90–90 (flat — no dynamic variation encoded in this MIDI)
- Written score dynamics include f, ff, and p (echo passages) — not reflected in MIDI data
- All per-note velocities stored in `metadata.json → violin_notes`

**Performance markings captured:** none (MIDI contains no articulation or expression data)

**Conversion parameters:**
- Quantise grid: 1/16 note (0.25 quarter notes)
- Rest threshold: 10% of a beat
- No string constraints

---

### Villoldo – El Choclo

| | |
|---|---|
| **File** | `songs/el_choclo/` |
| **Output** | `fingering/data_el_choclo.json` |
| **Source** | https://bitmidi.com/el-choclo-1-mid |
| **Direct URL** | https://bitmidi.com/uploads/42918.mid |
| **Downloaded** | 2026-05-21 |
| **SHA-256** | `c7fbf027246d4b6987a7ba823a41f2648fabb76c420152ad2a6870f7329388a0` |
| **MIDI sequencer** | Unknown |
| **Extracted channel** | Channel 4 (String Ensemble 1, GM 48) |

**MIDI format:** Type 0 — all channels in one track. Channel selection:

| Channel | Program | Instrument | Role |
|---|---|---|---|
| 1 | 32 | Acoustic Bass | Bass line |
| 2 | 23 | Tango Accordion | Accompaniment |
| **4** | **48** | **String Ensemble 1** | **Melody (extracted)** |
| 5 | 11 | Vibraphone | Ornamentation |
| 6 | 0 | Piano | Chords |
| 9 | — | Percussion | Rhythm |

**Sections:**

| Section | Key | Tempo | Notes |
|---|---|---|---|
| Introduction | A minor | 120 BPM (4/4) | Habanera-rhythm tango figures |
| A section (verse) | A minor | 120 BPM | Main melody, stepwise/chromatic motion |
| B section (chorus) | A minor/major | 120 BPM | Contrasting lyrical theme |
| Return / coda | A minor | 120 BPM | Recapitulation with tango ornamentation |

**Dynamics (melody channel):**
- Velocity range: 80–127 (mf to ff)
- Velocity mean: 109.4 — good expressive variation; tango accents visible as velocity spikes
- All per-note velocities stored in `metadata.json → violin_notes`

**Performance markings captured:** none

**Conversion parameters:**
- Quantise grid: 1/16 note (0.25 quarter notes)
- Rest threshold: 10% of a beat
- No string constraints

---

### Hisaishi – Merry-Go-Round of Life

| | |
|---|---|
| **File** | `songs/merry_go_round/` |
| **Output** | `fingering/data_merry_go_round.json` |
| **Source** | https://bitmidi.com/joe-hisaishi-merry-go-round-of-life-howls-moving-castle-mid |
| **Direct URL** | https://bitmidi.com/uploads/63179.mid |
| **Downloaded** | 2026-05-21 |
| **SHA-256** | `42151989424419fc5aede85f2e743a1d92080ef20177be7d4c2b5aa6468af644` |
| **Extracted track** | Track 2 "CH #1" (GM program 40 — Violin) |

**Sections:**

| Section | Key | Tempo | Notes |
|---|---|---|---|
| Main theme | Bb major | ~104 BPM (3/4) | Waltz-time melody |
| Development | Various | Variable | Tempo changes and modulations |
| Reprise / coda | Bb major | ~100 BPM → ritardando | Return of main theme |

**Dynamics (violin track):**
- Velocity: flat 127 throughout — no dynamics encoded in this MIDI

**Performance markings captured:** none

**Conversion parameters:**
- Quantise grid: 1/16 note (0.25 quarter notes)
- Rest threshold: 10% of a beat
- No string constraints

---

## Checklist for adding a new piece

- [ ] Download raw source file (MIDI / MusicXML / other), save to `songs/<piece>/raw/`
- [ ] Record SHA-256: `shasum -a 256 <file>`
- [ ] Inspect all tracks and pick the melody/solo track
- [ ] Extract full tempo map, time signature, key signature
- [ ] Identify all performance markings from the score (Sul G, Sul D, con sord., harmonics, etc.)
- [ ] Note velocity range and mean per track (dynamics)
- [ ] Write `metadata.json` following the schema above (include full `violin_notes` array)
- [ ] Write `import.py` — must be runnable from project root, must be deterministic
- [ ] Run `import.py`, verify output in `fingering/data_<piece>.json`
- [ ] Add a row to the **Pieces** section in this README
