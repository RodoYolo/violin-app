'use strict';

// ── Constants mirroring the Python model ──────────────────────────────────
const STRING_ORDER = ['G', 'D', 'A', 'E'];
const STRING_COLORS = { G: '#a78bfa', D: '#60a5fa', A: '#34d399', E: '#f87171' };
const FINGER_COLORS = { 0: '#facc15', 1: '#60a5fa', 2: '#34d399', 3: '#fb923c', 4: '#f472b6' };
const FINGER_LABELS = { 0: 'O', 1: '1', 2: '2', 3: '3', 4: '4' };
const POSITION_F1_OFFSET = {
  half: 1, 1: 2, 2: 4, 3: 5, 4: 7, 5: 9,
  6: 10, 7: 12, 8: 14, 9: 15, 10: 17, 11: 19, 12: 20,
};
const FINGER_OFFSETS = [0, 2, 3, 5]; // semitones above f1 for fingers 1-4

function physicalFret(note) {
  if (note.is_rest || note.finger === null) return null;
  if (note.finger === 0) return 0;
  const f1 = POSITION_F1_OFFSET[note.pos] ?? 0;
  return f1 + FINGER_OFFSETS[note.finger - 1];
}

// ── Load example data injected by Django ──────────────────────────────────
let EXAMPLES = {};
try {
  const raw = document.getElementById('examples-data');
  if (raw) EXAMPLES = JSON.parse(raw.textContent);
} catch (_) {}

// ── DOM refs ──────────────────────────────────────────────────────────────
const seqInput    = document.getElementById('sequence-input');
const solveBtn    = document.getElementById('solve-btn');
const errorMsg    = document.getElementById('error-msg');
const placeholder = document.getElementById('placeholder');
const results     = document.getElementById('results');
const tbody       = document.getElementById('result-body');
const statsBar    = document.getElementById('stats-bar');
const fbSvg       = document.getElementById('fingerboard-svg');
const noteList    = document.getElementById('note-list');   // hidden, kept for compat
const playBtn     = document.getElementById('play-btn');
const tempoSlider = document.getElementById('tempo-slider');
const volSlider   = document.getElementById('vol-slider');
const valBpm      = document.getElementById('val-bpm');
const valVol      = document.getElementById('val-vol');
const nvStrip     = document.getElementById('nv-strip');
const nvNoteName  = document.getElementById('nv-note-name');
const nvString    = document.getElementById('nv-string');
const nvPosFinger = document.getElementById('nv-pos-finger');
const nvFlags     = document.getElementById('nv-flags');
const nvPrev      = document.getElementById('nv-prev');
const nvNext      = document.getElementById('nv-next');
const staffContainer = document.getElementById('staff-container');
const seekSlider  = document.getElementById('seek-slider');
const seekCurrent = document.getElementById('seek-current');
const seekTotal   = document.getElementById('seek-total');

// tempoSlider input handled in playback section (also does live BPM)
volSlider.addEventListener('input', () => { valVol.textContent = volSlider.value; });

const reverseToggle = document.getElementById('reverse-toggle');

// Weight sliders
const sliders = {
  string_crossing: document.getElementById('w-string-crossing'),
  position_shift:  document.getElementById('w-position-shift'),
  high_position:   document.getElementById('w-high-position'),
  pinky:           document.getElementById('w-pinky'),
  open_string:     document.getElementById('w-open-string'),
  unconventional:  document.getElementById('w-unconventional'),
};
const valEls = {
  string_crossing: document.getElementById('val-sc'),
  position_shift:  document.getElementById('val-ps'),
  high_position:   document.getElementById('val-hp'),
  pinky:           document.getElementById('val-pk'),
  open_string:     document.getElementById('val-os'),
  unconventional:  document.getElementById('val-uc'),
};

Object.entries(sliders).forEach(([key, el]) => {
  el.addEventListener('input', () => { valEls[key].textContent = el.value; });
});

// ── State ─────────────────────────────────────────────────────────────────
let lastResult = [];
let audioCtx = null;
let isPlaying = false;
let isPaused = false;
let stopRequested = false;
let activeTimeouts = [];
let currentPlayingIndex = 0;   // tracks which note is currently playing

// ── Example buttons ───────────────────────────────────────────────────────
document.querySelectorAll('.example-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.example-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const ex = EXAMPLES[btn.dataset.key];
    if (!ex) return;
    seqInput.value = ex.sequence.map(([p, d]) =>
      p === null ? `rest ${d}` : `${p} ${d}`
    ).join('\n');
    if (ex.bpm) {
      tempoSlider.value = ex.bpm;
      valBpm.textContent = ex.bpm;
    }
    solveBtn.click();
  });
});

// ── Parse textarea ────────────────────────────────────────────────────────
function parseSequence(text) {
  const lines = text.trim().split('\n').filter(l => l.trim());
  return lines.map((line, i) => {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 2) throw new Error(`Line ${i + 1}: expected "PITCH DURATION"`);
    const pitch = parts[0].toLowerCase() === 'rest' ? null : parseInt(parts[0], 10);
    const dur   = parseFloat(parts[1]);
    if (pitch !== null && (isNaN(pitch) || pitch < 55 || pitch > 101))
      throw new Error(`Line ${i + 1}: MIDI pitch must be 55–101 / G3–E7 (or "rest")`);
    if (isNaN(dur) || dur <= 0)
      throw new Error(`Line ${i + 1}: duration must be a positive number`);
    return [pitch, dur];
  });
}

function getWeights() {
  const w = {};
  Object.entries(sliders).forEach(([k, el]) => { w[k] = parseFloat(el.value); });
  return w;
}

// ── Solve ─────────────────────────────────────────────────────────────────
solveBtn.addEventListener('click', async () => {
  stopPlayback();
  hideError();
  let sequence;
  try { sequence = parseSequence(seqInput.value); }
  catch (e) { showError(e.message); return; }

  if (reverseToggle.checked) sequence = [...sequence].reverse();

  solveBtn.classList.add('loading');
  solveBtn.textContent = reverseToggle.checked ? 'Solving (reversed)…' : 'Solving…';

  try {
    const resp = await fetch('/api/solve/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sequence, weights: getWeights() }),
    });
    const data = await resp.json();
    if (!data.ok) throw new Error(data.error);
    lastResult = data.result;
    render(data.result, data.opt);
  } catch (e) {
    showError(e.message);
  } finally {
    solveBtn.classList.remove('loading');
    solveBtn.textContent = 'Solve Fingering';
  }
});

// ── Render results ────────────────────────────────────────────────────────
function render(notes, opt) {
  placeholder.classList.add('hidden');
  results.classList.remove('hidden');
  renderStrip(notes);
  renderTable(notes);
  renderStats(notes);
  renderOptimization(opt);
  // Configure seek bar range
  seekSlider.max = Math.max(0, notes.length - 1);
  seekSlider.value = 0;
  seekTotal.textContent = `/ ${notes.length}`;
  updateSeekUI(0);
  selectNote(0, notes, { scroll: false });
}

function renderOptimization(opt) {
  const grid = document.getElementById('opt-grid');
  const meta = document.getElementById('opt-summary-meta');
  if (!opt || !grid) return;

  const fmt = n => n.toLocaleString();
  meta.textContent =
    `${fmt(opt.n_variables)} vars · ${fmt(opt.lattice_nodes)} states · ${opt.hard_constraints + opt.soft_terms} constraints`;

  grid.innerHTML = `
    <div class="opt-stat">
      <div class="opt-val">${fmt(opt.n_variables)}</div>
      <span class="opt-label">Decision variables</span>
      <span class="opt-hint">one categorical xᵢ per note</span>
    </div>
    <div class="opt-stat">
      <div class="opt-val">${fmt(opt.lattice_nodes)}</div>
      <span class="opt-label">Lattice nodes</span>
      <span class="opt-hint">Σᵢ |Aᵢ| — total DP states</span>
    </div>
    <div class="opt-stat">
      <div class="opt-val">${fmt(opt.dp_edges)}</div>
      <span class="opt-label">DP edges</span>
      <span class="opt-hint">transitions evaluated by Viterbi</span>
    </div>
    <div class="opt-stat">
      <div class="opt-val">${opt.avg_branching}</div>
      <span class="opt-label">Avg branching</span>
      <span class="opt-hint">mean assignments per note (max ${opt.max_branching})</span>
    </div>
    <div class="opt-stat">
      <div class="opt-val">${opt.hard_constraints}</div>
      <span class="opt-label">Hard constraints</span>
      <span class="opt-hint">pitch match · max shift ≤ 12 semitones</span>
    </div>
    <div class="opt-stat">
      <div class="opt-val">${opt.soft_terms}</div>
      <span class="opt-label">Soft cost terms</span>
      <span class="opt-hint">crossing · shift · high-pos · pinky · open · convention</span>
    </div>
  `;
}

// ── STRIP ─────────────────────────────────────────────────────────────────
function renderStrip(notes) {
  nvStrip.innerHTML = '';
  notes.forEach(n => {
    const card = document.createElement('div');
    card.className = 'nv-card' + (n.is_rest ? ' nv-rest' : '');
    card.dataset.index = n.index;
    const color = n.is_rest ? '#4b4b6a' : (FINGER_COLORS[n.finger] ?? '#fff');
    card.innerHTML = `
      <div class="nv-card-num">#${n.index + 1}</div>
      <div class="nv-card-dot" style="background:${color}">${n.is_rest ? '—' : FINGER_LABELS[n.finger]}</div>
      <div class="nv-card-name">${n.note_name}</div>`;
    card.addEventListener('click', () => selectNote(n.index, notes, { scroll: true }));
    nvStrip.appendChild(card);
  });

  nvPrev.addEventListener('click', () => {
    const cur = parseInt(nvStrip.querySelector('.nv-active')?.dataset.index ?? '0');
    if (cur > 0) selectNote(cur - 1, notes, { scroll: true });
  });
  nvNext.addEventListener('click', () => {
    const cur = parseInt(nvStrip.querySelector('.nv-active')?.dataset.index ?? '0');
    if (cur < notes.length - 1) selectNote(cur + 1, notes, { scroll: true });
  });
}

// ── TABLE ─────────────────────────────────────────────────────────────────
function renderTable(notes) {
  tbody.innerHTML = '';
  notes.forEach(n => {
    const tr = document.createElement('tr');
    tr.dataset.index = n.index;
    if (n.is_rest) tr.classList.add('is-rest');

    const flagsHtml = (n.flags || []).map(f => {
      let cls = 'flag';
      if (f.includes('crossing')) cls += ' crossing';
      else if (f.includes('shift')) cls += ' shift';
      else if (f.includes('open')) cls += ' open';
      else if (f.includes('free')) cls += ' free';
      return `<span class="${cls}">${f}</span>`;
    }).join(' ');

    const stringCell = n.string
      ? `<span class="string-badge str-${n.string}">${n.string}</span>` : '—';

    const fingerCell = (!n.is_rest && n.finger !== null)
      ? `<span class="finger-pill f${n.finger}">${n.finger === 0 ? 'O' : n.finger}</span>` : '—';

    tr.innerHTML = `
      <td>${n.index + 1}</td>
      <td><strong>${n.note_name}</strong></td>
      <td>${stringCell}</td>
      <td>${n.pos_label || '—'}</td>
      <td>${fingerCell}</td>
      <td>${n.duration}♩</td>
      <td>${flagsHtml}</td>
    `;
    tr.addEventListener('click', () => selectNote(n.index, lastResult, { scroll: true }));
    tbody.appendChild(tr);
  });
}

// ── SELECT NOTE — updates strip, info panel, and single-note neck ─────────
function selectNote(index, notes, { scroll = false } = {}) {
  if (!notes || !notes.length || !nvStrip) return;
  index = Math.max(0, Math.min(index, notes.length - 1));
  const n = notes[index];

  // Strip highlight + hide already-played cards during playback
  nvStrip.querySelectorAll('.nv-card').forEach(c => {
    const i = parseInt(c.dataset.index);
    c.classList.toggle('nv-active',    i === index);
    c.classList.toggle('nv-adjacent',  i === index - 1 || i === index + 1);
    // Hide cards that are already past during playback for a cleaner view
    c.classList.toggle('nv-past',      isPlaying && i < index);
  });

  // Scroll the strip — manipulate only the strip's own horizontal scroll,
  // never the page. scrollIntoView with block:'nearest' can still cause
  // page scroll in some browsers, so we compute scrollLeft manually.
  const activeCard = nvStrip.querySelector('.nv-active');
  if (activeCard && nvStrip.parentElement) {
    const scroller = nvStrip.parentElement;   // .nv-strip-scroll
    const target = activeCard.offsetLeft - scroller.clientWidth / 2 + activeCard.offsetWidth / 2;
    if (scroll) {
      scroller.scrollTo({ left: target, behavior: 'smooth' });
    } else {
      scroller.scrollLeft = target;
    }
  }

  // Arrow states
  nvPrev.disabled = index === 0;
  nvNext.disabled = index === notes.length - 1;

  // Info panel
  if (n.is_rest) {
    nvNoteName.textContent = '—';
    nvNoteName.style.color = 'var(--muted)';
    nvString.textContent = 'Rest';
    nvPosFinger.textContent = 'hand free to shift';
    nvFlags.innerHTML = '';
  } else {
    const color = FINGER_COLORS[n.finger] ?? 'var(--accent)';
    nvNoteName.textContent = n.note_name;
    nvNoteName.style.color = color;
    nvString.textContent = `${n.string} string`;
    nvPosFinger.innerHTML = `<span class="nv-pos">Pos ${n.pos_label}</span><span class="nv-sep">›</span><span class="nv-finger">${FINGER_NAMES[n.finger] ?? ''}</span>`;
    nvFlags.innerHTML = (n.flags||[]).map(f => `<span>${f}</span>`).join('');
  }

  // Draw neck for this note
  drawSingleNoteNeck(n, notes[index - 1] ?? null, notes[index + 1] ?? null);

  // Auto-scroll the neck card so the active note's dot stays in view
  scrollNeckTo(n);

  // Draw moving staff centered on the current note
  drawStaff(notes, index);

  // Update seek UI (but don't recurse — only when not currently dragging)
  if (document.activeElement !== seekSlider) updateSeekUI(index);

  // Table row — highlight only, NEVER scroll the page during playback.
  tbody.querySelectorAll('tr.is-active').forEach(r => r.classList.remove('is-active'));
  const tr = tbody.querySelector(`tr[data-index="${index}"]`);
  if (tr) tr.classList.add('is-active');
}

// ── SINGLE-NOTE NECK SVG ──────────────────────────────────────────────────
function drawSingleNoteNeck(current, prev, next) {
  const mL = 100, mR = 40, mT = 90, mB = 50;
  const STRING_GAP = 140, DOT_R = 48;
  const H = mT + 3 * STRING_GAP + mB;   // 90 + 420 + 50 = 560

  // Compute the highest semitone reached anywhere in the piece so the neck
  // expands enough to show every dot — covers up to position 12 if needed.
  const allFrets = (lastResult || [])
    .map(physicalFret)
    .filter(f => f !== null);
  const maxSemitone = Math.max(13, ...allFrets) + 1;

  // Neck width scales with the semitone count so high positions remain readable.
  const semiPx = 110;   // pixels per semitone
  const neckW = Math.max(1200, maxSemitone * semiPx);
  const W = mL + neckW + mR;

  // Force the SVG to render at its actual pixel size — no shrinking to fit.
  // Container `.nv-neck-scroll` provides horizontal scrolling.
  fbSvg.setAttribute('width', W);
  fbSvg.style.width = W + 'px';

  fbSvg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  fbSvg.setAttribute('height', H);

  const semiX  = s  => mL + (s / maxSemitone) * neckW;
  const stringY = si => mT + si * STRING_GAP;

  const POS_MARKS = Object.entries(POSITION_F1_OFFSET)
    .filter(([, v]) => v <= maxSemitone)
    .sort((a, b) => a[1] - b[1]);

  let html = '';

  // Neck background
  html += `<rect x="${mL}" y="${mT - 8}" width="${neckW}" height="${3 * STRING_GAP + 16}"
    rx="4" fill="#16161f" stroke="#2a2a3a" stroke-width="1"/>`;
  // Nut
  html += `<rect x="${mL}" y="${mT - 8}" width="5" height="${3 * STRING_GAP + 16}" fill="#555570" rx="2"/>`;

  // Grid lines at position marks
  POS_MARKS.forEach(([name, semi]) => {
    const x = semiX(semi);
    html += `<line x1="${x}" y1="${mT - 8}" x2="${x}" y2="${mT + 3 * STRING_GAP + 8}"
      stroke="#2e2e48" stroke-width="1.5"/>`;
    html += `<text x="${x}" y="${mT - 20}" text-anchor="middle"
      font-size="19" fill="#45455a">${name}</text>`;
  });

  // String lines
  STRING_ORDER.forEach((s, i) => {
    const y = stringY(i);
    const sw = [2.2, 1.7, 1.2, 0.8][i];
    html += `<line x1="${mL + 5}" y1="${y}" x2="${mL + neckW}" y2="${y}"
      stroke="${STRING_COLORS[s]}" stroke-width="${sw}" stroke-opacity="0.45"/>`;
    html += `<text x="${mL - 14}" y="${y + 10}" text-anchor="end"
      font-size="30" font-weight="800" fill="${STRING_COLORS[s]}">${s}</text>`;
  });

  // Ghost dot — previous note (grayscale, faded — already played)
  if (prev && !prev.is_rest) {
    const f = physicalFret(prev);
    if (f !== null) {
      const cx = semiX(f), cy = stringY(prev.string_index);
      html += `<circle cx="${cx}" cy="${cy}" r="${DOT_R - 2}" fill="#5a5a6e" opacity="0.55"/>`;
      html += `<text x="${cx}" y="${cy + 8}" text-anchor="middle"
        font-size="22" font-weight="700" fill="#1a1a24" opacity="0.85">${FINGER_LABELS[prev.finger]}</text>`;
    }
  }

  // Ghost dot — next note (faint preview in finger color)
  if (next && !next.is_rest) {
    const f = physicalFret(next);
    if (f !== null) {
      const cx = semiX(f), cy = stringY(next.string_index);
      const color = FINGER_COLORS[next.finger] ?? '#fff';
      html += `<circle cx="${cx}" cy="${cy}" r="${DOT_R - 2}" fill="${color}" opacity="0.28"/>`;
      html += `<text x="${cx}" y="${cy + 8}" text-anchor="middle"
        font-size="22" font-weight="700" fill="#0f0f13" opacity="0.7">${FINGER_LABELS[next.finger]}</text>`;
    }
  }

  // String-crossing arc — drawn before the current dot so it sits behind
  const isCrossing = !current.is_rest && prev && !prev.is_rest
    && prev.string_index !== current.string_index
    && physicalFret(prev) !== null && physicalFret(current) !== null;

  if (isCrossing) {
    const fPrev = physicalFret(prev),  fCur = physicalFret(current);
    const x1 = semiX(fPrev), y1 = stringY(prev.string_index);
    const x2 = semiX(fCur),  y2 = stringY(current.string_index);
    // Curved arc bowing outward from the midpoint
    const mx = (x1 + x2) / 2;
    const direction = y2 > y1 ? 1 : -1;     // crossing down vs. up
    const arcOffset = 42 * direction;       // bow amount
    const cy = ((y1 + y2) / 2) + arcOffset;
    // Quadratic curve
    html += `<defs>
      <marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
        <path d="M 0 0 L 10 5 L 0 10 z" fill="#fb923c"/>
      </marker>
    </defs>`;
    html += `<path d="M ${x1} ${y1} Q ${mx} ${cy} ${x2} ${y2}"
      fill="none" stroke="#fb923c" stroke-width="2.5"
      stroke-dasharray="6 4"
      marker-end="url(#arrow)"
      opacity="0.85">
      <animate attributeName="stroke-dashoffset"
        from="0" to="-20" dur="0.9s" repeatCount="indefinite"/>
    </path>`;
    // Crossing label badge near the arc apex
    const labelY = cy + (direction > 0 ? 6 : -6);
    html += `<text x="${mx}" y="${labelY}" text-anchor="middle"
      font-size="9" font-weight="700" fill="#fb923c">${prev.string} → ${current.string}</text>`;
  }

  // Current note dot
  if (!current.is_rest) {
    const f = physicalFret(current);
    if (f !== null) {
      const cx = semiX(f), cy = stringY(current.string_index);
      const color = FINGER_COLORS[current.finger] ?? '#fff';
      // Extra orange ring when this note is the target of a string crossing
      if (isCrossing) {
        html += `<circle cx="${cx}" cy="${cy}" r="${DOT_R + 9}" fill="none"
          stroke="#fb923c" stroke-width="2" opacity="0.6">
          <animate attributeName="r" values="${DOT_R + 6};${DOT_R + 11};${DOT_R + 6}" dur="1.2s" repeatCount="indefinite"/>
          <animate attributeName="opacity" values="0.7;0.2;0.7" dur="1.2s" repeatCount="indefinite"/>
        </circle>`;
      }
      html += `<circle cx="${cx}" cy="${cy}" r="${DOT_R + 6}" fill="${color}" opacity="0.15"/>`;
      html += `<circle cx="${cx}" cy="${cy}" r="${DOT_R}" fill="${color}" stroke="#fff" stroke-width="2"/>`;
      html += `<text x="${cx}" y="${cy + 12}" text-anchor="middle"
        font-size="32" font-weight="900" fill="#0f0f13">${FINGER_LABELS[current.finger]}</text>`;
    }
  } else {
    // Rest — dim message
    const cx = mL + neckW / 2, cy = mT + 1.5 * STRING_GAP;
    html += `<text x="${cx}" y="${cy + 6}" text-anchor="middle"
      font-size="16" fill="#4b4b6a" font-style="italic">rest — hand free to shift</text>`;
  }

  fbSvg.innerHTML = html;
}

// Scroll the neck container horizontally so the current note is in view.
function scrollNeckTo(note) {
  if (!note || note.is_rest) return;
  const scroller = fbSvg.parentElement;   // .nv-neck-scroll
  if (!scroller) return;
  const vb = (fbSvg.getAttribute('viewBox') || '').split(/\s+/).map(Number);
  if (vb.length < 4) return;
  const vbW = vb[2];
  const f = physicalFret(note);
  if (f === null) return;

  // Compute approximate x of this note in the rendered SVG
  const svgRect = fbSvg.getBoundingClientRect();
  if (svgRect.width === 0) return;
  const scale = svgRect.width / vbW;

  // Mirror the semiX math from drawSingleNoteNeck
  const mL = 56;
  const allFrets = (lastResult || []).map(physicalFret).filter(x => x !== null);
  const maxSemitone = Math.max(13, ...allFrets) + 1;
  const semiPx = 42;
  const neckW = Math.max(540, maxSemitone * semiPx);
  const noteXInVb = mL + (f / maxSemitone) * neckW;
  const noteXOnScreen = noteXInVb * scale;

  const target = noteXOnScreen - scroller.clientWidth / 2;
  scroller.scrollTo({ left: target, behavior: isPlaying ? 'smooth' : 'auto' });
}

// ── MOVING STAFF (VexFlow) ────────────────────────────────────────────────

const VEX_PITCH_NAMES = ['c','c#','d','d#','e','f','f#','g','g#','a','a#','b'];

function midiToVexKey(midi) {
  return `${VEX_PITCH_NAMES[midi % 12]}/${Math.floor(midi / 12) - 1}`;
}

function durationToVexDur(dur) {
  const dot =
    Math.abs(dur - 6)    < 0.05 ||
    Math.abs(dur - 3)    < 0.05 ||
    Math.abs(dur - 1.5)  < 0.05 ||
    Math.abs(dur - 0.75) < 0.05;
  const base = dot ? dur / 1.5 : dur;
  const d = base >= 4 ? 'w' : base >= 2 ? 'h' : base >= 1 ? 'q'
          : base >= 0.5 ? '8' : base >= 0.25 ? '16' : '32';
  return dot ? d + 'd' : d;
}

function drawStaff(notes, centerIndex) {
  staffContainer.innerHTML = '';
  if (!notes.length) return;

  const { Renderer, Stave, StaveNote, Voice, Formatter, Beam, Accidental, Annotation } = Vex.Flow;

  const SHOW_BEFORE = 4;
  const SHOW_AFTER  = 8;
  const WINDOW      = SHOW_BEFORE + 1 + SHOW_AFTER;

  const W      = staffContainer.clientWidth || 800;
  const H      = 190;
  const staveY = 28;
  // Wide stave so all notes fit — content will be shifted to center the current note
  const staveW = WINDOW * 72 + 120;

  // Collect visible window
  const items = [];
  for (let off = 0; off < WINDOW; off++) {
    const i = centerIndex - SHOW_BEFORE + off;
    if (i >= 0 && i < notes.length) items.push({ i, n: notes[i] });
  }
  if (!items.length) return;

  const renderer = new Renderer(staffContainer, Renderer.Backends.SVG);
  renderer.resize(W, H);
  const ctx = renderer.getContext();
  ctx.setFont('Arial', 10, '');

  const stave = new Stave(0, staveY, staveW);
  stave.addClef('treble');
  stave.setStyle({ strokeStyle: '#4a4a6a', fillStyle: '#4a4a6a' });
  stave.setContext(ctx).draw();

  // Recolor clef glyph: it's a filled <path>; stave lines are stroked paths with fill="none".
  staffContainer.querySelectorAll('svg path').forEach(p => {
    p.setAttribute('fill', '#e2e2f0');
  });

  // Build StaveNotes with per-note colours
  const vexNotes = items.map(({ i, n }) => {
    const isCurrent = i === centerIndex;
    const alpha     = isCurrent ? 1 : Math.max(0.18, 1 - Math.abs(i - centerIndex) * 0.1);
    const noteCol   = isCurrent ? (FINGER_COLORS[n.finger] ?? '#e2e2f0')
                                : `rgba(130,130,175,${alpha.toFixed(2)})`;
    const restCol   = isCurrent ? '#c0c0d4' : `rgba(100,100,140,${alpha.toFixed(2)})`;

    if (n.is_rest) {
      const vn = new StaveNote({ keys: ['b/4'], duration: durationToVexDur(n.duration) + 'r' });
      vn.setStyle({ fillStyle: restCol, strokeStyle: restCol });
      return vn;
    }

    const key = midiToVexKey(n.midi_pitch);
    const vn  = new StaveNote({ keys: [key], duration: durationToVexDur(n.duration) });
    vn.setStyle({ fillStyle: noteCol, strokeStyle: noteCol });

    if (key.includes('#')) {
      const acc = new Accidental('#');
      acc.setStyle({ fillStyle: noteCol, strokeStyle: noteCol });
      vn.addModifier(acc, 0);
    }

    // ── Finger number annotation above the note ──────────────────────────
    if (n.finger !== null) {
      const fingerLabel = n.finger === 0 ? 'O' : String(n.finger);
      const ann = new Annotation(fingerLabel);
      ann.setFont('Arial', isCurrent ? 11 : 9, isCurrent ? 'bold' : 'normal');
      ann.setVerticalJustification(Annotation.VerticalJustify.TOP);
      ann.setStyle({ fillStyle: noteCol, strokeStyle: noteCol });
      vn.addModifier(ann, 0);
    }

    return vn;
  });

  const voice = new Voice({ num_beats: 4, beat_value: 4 }).setMode(Voice.Mode.SOFT);
  voice.addTickables(vexNotes);

  const noteAreaW = staveW - stave.getNoteStartX() - 16;
  new Formatter().joinVoices([voice]).format([voice], noteAreaW);
  voice.draw(ctx, stave);

  // Shift all VexFlow content so the current note lands at W/2
  const curIdx   = items.findIndex(it => it.i === centerIndex);
  const svgEl    = staffContainer.querySelector('svg');
  if (curIdx < 0 || !svgEl) return;

  svgEl.setAttribute('overflow', 'hidden');
  const curNoteX = vexNotes[curIdx].getAbsoluteX();
  const shift    = Math.round(W / 2 - curNoteX);

  const wrapper = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  wrapper.setAttribute('transform', `translate(${shift}, 0)`);
  while (svgEl.firstChild) wrapper.appendChild(svgEl.firstChild);
  svgEl.appendChild(wrapper);

  // Playhead — fixed at W/2, outside the shifted wrapper
  const mkEl = (tag, attrs) => {
    const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
    Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, v));
    return el;
  };
  svgEl.appendChild(mkEl('line', {
    x1: W / 2, y1: staveY - 20, x2: W / 2, y2: staveY + 42,
    stroke: 'var(--accent)', 'stroke-width': 1.5,
    'stroke-dasharray': '3 3', opacity: 0.55,
  }));

  // Note name label — pill with opaque background so it always reads over notes
  const curItem = items[curIdx];
  if (!curItem.n.is_rest) {
    const color   = FINGER_COLORS[curItem.n.finger] ?? '#e2e2f0';
    const label   = curItem.n.note_name;
    const pillW   = label.length * 7 + 14;
    const pillH   = 17;
    const pillX   = W / 2 - pillW / 2;
    const pillY   = H - pillH - 4;  // always pinned to bottom of SVG
    svgEl.appendChild(mkEl('rect', {
      x: pillX, y: pillY, width: pillW, height: pillH,
      rx: 4, fill: '#12121a', opacity: 0.92,
    }));
    const txt = mkEl('text', {
      x: W / 2, y: pillY + pillH - 4,
      'text-anchor': 'middle', 'font-size': 11, 'font-weight': 800, fill: color,
    });
    txt.textContent = label;
    svgEl.appendChild(txt);
  }
}

// ── OLD FINGERBOARD (unused) ──────────────────────────────────────────────
function renderFingerboard(notes) {
  // Layout constants
  const mL = 40;       // left margin — string labels (padding handles the rest)
  const mR = 24;       // right margin
  const mT = 44;       // top margin — position labels
  const mB = 18;       // bottom margin
  const STRING_GAP = 34;
  const DOT_R = 12;

  // How many semitones to show (at least through position 7 = fret 12)
  const usedFrets = notes.map(physicalFret).filter(f => f !== null);
  const maxSemitone = Math.max(12, ...usedFrets) + 1;

  // Fixed total width for the neck (scales with content)
  const neckW = Math.max(540, maxSemitone * 46);
  const W = mL + neckW + mR;
  const H = mT + 3 * STRING_GAP + mB;

  fbSvg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  fbSvg.setAttribute('height', H);

  // Coordinate helpers
  const semiX  = s  => mL + (s / maxSemitone) * neckW;  // x for a semitone position
  const stringY = si => mT + si * STRING_GAP;

  // Conventional position f1-semitone values that we'll mark
  const POS_MARKS = Object.entries(POSITION_F1_OFFSET)
    .filter(([, v]) => v <= maxSemitone)
    .sort((a, b) => a[1] - b[1]);

  let html = '';

  // ── Background neck ──────────────────────────────────────────────────
  html += `<rect x="${mL}" y="${mT - 10}" width="${neckW}" height="${3 * STRING_GAP + 20}"
    rx="4" fill="#16161f" stroke="#2a2a3a" stroke-width="1"/>`;

  // ── Nut (thick left bar) ─────────────────────────────────────────────
  html += `<rect x="${mL}" y="${mT - 10}" width="5" height="${3 * STRING_GAP + 20}"
    fill="#555570" rx="2"/>`;

  // ── Semitone grid lines (subtle) ─────────────────────────────────────
  for (let s = 1; s <= maxSemitone; s++) {
    const x = semiX(s);
    const isPos = POS_MARKS.some(([, v]) => v === s);
    html += `<line x1="${x}" y1="${mT - 10}" x2="${x}" y2="${mT + 3 * STRING_GAP + 10}"
      stroke="${isPos ? '#3a3a5a' : '#1e1e2a'}" stroke-width="${isPos ? 1.5 : 0.5}"/>`;
  }

  // ── Position labels above neck ────────────────────────────────────────
  POS_MARKS.forEach(([name, semi]) => {
    const x = semiX(semi);
    // small tick
    html += `<line x1="${x}" y1="${mT - 14}" x2="${x}" y2="${mT - 10}"
      stroke="#4a4a6a" stroke-width="1.5"/>`;
    html += `<text x="${x}" y="${mT - 17}" text-anchor="middle"
      font-size="9" font-family="monospace" fill="#5a5a80">${name}</text>`;
  });

  // ── String lines ──────────────────────────────────────────────────────
  STRING_ORDER.forEach((s, i) => {
    const y = stringY(i);
    const sw = [2.4, 1.8, 1.3, 0.9][i];
    html += `<line x1="${mL + 5}" y1="${y}" x2="${mL + neckW}" y2="${y}"
      stroke="${STRING_COLORS[s]}" stroke-width="${sw}" stroke-opacity="0.5"/>`;
    html += `<text x="${mL - 8}" y="${y + 4}" text-anchor="end"
      font-size="13" font-weight="800" fill="${STRING_COLORS[s]}">${s}</text>`;
  });

  // ── Open-string marker labels (semitone 0) ────────────────────────────
  html += `<text x="${mL - 8}" y="${mT - 17}" text-anchor="end"
    font-size="9" fill="#3a3a55">open</text>`;

  // ── Collect notes per UNIQUE (fret, stringIndex, finger) fingering ───
  // Each cell may be hit by many note indices; we render one dot per
  // unique fingering and store all indices that use it for highlighting.
  const cells = new Map();
  notes.forEach(n => {
    if (n.is_rest) return;
    const f = physicalFret(n);
    if (f === null) return;
    const key = `${f},${n.string_index},${n.finger}`;
    if (!cells.has(key)) {
      cells.set(key, { fret: f, si: n.string_index, finger: n.finger, indices: [] });
    }
    cells.get(key).indices.push(n.index);
  });

  // ── Draw string-crossing lines only for short sequences ──────────────
  // Above ~120 notes the lines turn into noise; skip them for clarity.
  if (notes.length <= 120) {
    for (let i = 1; i < notes.length; i++) {
      const a = notes[i - 1], b = notes[i];
      if (a.is_rest || b.is_rest) continue;
      if (a.string_index === b.string_index) continue;
      const fa = physicalFret(a), fb = physicalFret(b);
      if (fa === null || fb === null) continue;
      html += `<line x1="${semiX(fa)}" y1="${stringY(a.string_index)}"
                 x2="${semiX(fb)}" y2="${stringY(b.string_index)}"
        stroke="#fb923c" stroke-width="1.2" stroke-dasharray="5 3" stroke-opacity="0.45"/>`;
    }
  }

  // ── Group unique fingerings per (fret, string) cell for vertical stacking ─
  // Same (fret, string) but different finger numbers stack a little.
  const cellGroups = new Map();
  cells.forEach((cell, key) => {
    const gkey = `${cell.fret},${cell.si}`;
    if (!cellGroups.has(gkey)) cellGroups.set(gkey, []);
    cellGroups.get(gkey).push(cell);
  });

  // ── Render dots: one per unique fingering ──────────────────────────────
  cellGroups.forEach((cellList, gkey) => {
    const [fStr, siStr] = gkey.split(',');
    const f  = Number(fStr);
    const si = Number(siStr);
    const cx = semiX(f);
    const baseY = stringY(si);

    cellList.forEach((cell, slot) => {
      const offsets = [0, -(DOT_R * 2 + 4), (DOT_R * 2 + 4),
                       -(DOT_R * 4 + 8), (DOT_R * 4 + 8)];
      const cy = baseY + (offsets[slot] ?? slot * (DOT_R * 2 + 4));

      const color = FINGER_COLORS[cell.finger] ?? '#fff';
      // Encode indices as a space-separated list so the highlighter can find this dot.
      const idxAttr = cell.indices.join(' ');

      html += `<g class="fb-note" data-indices="${idxAttr}">`;
      html += `<circle cx="${cx}" cy="${cy}" r="${DOT_R + 5}" fill="${color}" opacity="0.10"/>`;
      html += `<circle cx="${cx}" cy="${cy}" r="${DOT_R}" fill="${color}"
        stroke="#0f0f13" stroke-width="1.5" class="fb-dot"/>`;
      html += `<text x="${cx}" y="${cy + 4}" text-anchor="middle"
        font-size="12" font-weight="800" fill="#0f0f13">${FINGER_LABELS[cell.finger]}</text>`;
      html += `</g>`;
    });
  });

  fbSvg.innerHTML = html;
}

// ── STATS ─────────────────────────────────────────────────────────────────
function renderStats(notes) {
  const nonRests = notes.filter(n => !n.is_rest);
  let crossings = 0, totalShift = 0, maxPos = 0;
  for (let i = 1; i < notes.length; i++) {
    const a = notes[i - 1], b = notes[i];
    if (a.is_rest || b.is_rest) continue;
    if (a.string !== b.string) crossings++;
    const p1 = posOffset(a.pos), p2 = posOffset(b.pos);
    totalShift += Math.abs(p1 - p2);
  }
  nonRests.forEach(n => { const p = posOffset(n.pos); if (p > maxPos) maxPos = p; });
  const posLabel = Object.entries(POSITION_F1_OFFSET).find(([, v]) => v === maxPos)?.[0] || maxPos;
  const fmt = n => n.toLocaleString();
  statsBar.innerHTML = `
    <div class="stat"><strong>${fmt(nonRests.length)}</strong><span>Notes</span></div>
    <div class="stat"><strong>${fmt(crossings)}</strong><span>Cross</span></div>
    <div class="stat"><strong>${fmt(totalShift)}</strong><span>Shift</span></div>
    <div class="stat"><strong>${posLabel}</strong><span>High pos</span></div>
  `;
}

function posOffset(pos) {
  if (pos === null || pos === undefined) return 0;
  return POSITION_F1_OFFSET[pos] ?? 0;
}

// ── AUDIO ENGINE ──────────────────────────────────────────────────────────

function midiToHz(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

function getAudioCtx() {
  if (!audioCtx || audioCtx.state === 'closed') {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

function playViolinNote(ctx, freq, startTime, duration, volume) {
  const masterGain = ctx.createGain();
  masterGain.connect(ctx.destination);

  // Sawtooth base — violin is rich in odd+even harmonics
  const osc = ctx.createOscillator();
  osc.type = 'sawtooth';
  osc.frequency.setValueAtTime(freq, startTime);

  // Subtle vibrato via LFO
  const lfo = ctx.createOscillator();
  const lfoGain = ctx.createGain();
  lfo.frequency.setValueAtTime(5.5, startTime); // ~5.5 Hz vibrato
  lfoGain.gain.setValueAtTime(0, startTime);
  // Vibrato kicks in after ~0.15s
  lfoGain.gain.linearRampToValueAtTime(freq * 0.003, startTime + 0.15);
  lfo.connect(lfoGain);
  lfoGain.connect(osc.frequency);

  // Warmth filter — cut harsh highs
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.setValueAtTime(2800, startTime);
  filter.Q.setValueAtTime(0.7, startTime);

  // Slight body resonance bump
  const body = ctx.createBiquadFilter();
  body.type = 'peaking';
  body.frequency.setValueAtTime(300, startTime);
  body.gain.setValueAtTime(4, startTime);
  body.Q.setValueAtTime(1.5, startTime);

  osc.connect(filter);
  filter.connect(body);
  body.connect(masterGain);

  // ADSR envelope
  const attack  = Math.min(0.04, duration * 0.1);
  const decay   = Math.min(0.08, duration * 0.15);
  const sustain = volume * 0.72;
  const release = Math.min(0.12, duration * 0.2);
  const end     = startTime + duration;

  masterGain.gain.setValueAtTime(0, startTime);
  masterGain.gain.linearRampToValueAtTime(volume, startTime + attack);
  masterGain.gain.linearRampToValueAtTime(sustain, startTime + attack + decay);
  masterGain.gain.setValueAtTime(sustain, end - release);
  masterGain.gain.linearRampToValueAtTime(0, end);

  osc.start(startTime);
  lfo.start(startTime);
  osc.stop(end + 0.01);
  lfo.stop(end + 0.01);
}

// ── PLAYBACK CONTROL ──────────────────────────────────────────────────────

const pauseBtn = document.getElementById('pause-btn');
const stopBtn  = document.getElementById('stop-btn');

playBtn.addEventListener('click', () => {
  if (!lastResult.length) return;
  if (isPaused) {
    startPlayback(lastResult, currentPlayingIndex);   // resume from paused note
  } else {
    startPlayback(lastResult, 0);                     // start from beginning
  }
});

pauseBtn.addEventListener('click', pausePlayback);
stopBtn.addEventListener('click',  () => stopPlayback(true));

// Keyboard shortcuts (ignore when typing in an input)
document.addEventListener('keydown', e => {
  if (e.target.matches('input, textarea, select, button')) return;

  if (e.code === 'Space') {
    e.preventDefault();
    if (isPlaying) {
      pausePlayback();
    } else if (lastResult.length) {
      startPlayback(lastResult, isPaused ? currentPlayingIndex : 0);
    }
    return;
  }

  // Arrow keys step through notes when not playing
  if (!isPlaying && lastResult.length) {
    if (e.code === 'ArrowRight') {
      e.preventDefault();
      jumpTo(currentPlayingIndex + 1);
    } else if (e.code === 'ArrowLeft') {
      e.preventDefault();
      jumpTo(currentPlayingIndex - 1);
    }
  }
});

// ── Skip / rewind / forward buttons ─────────────────────────────────────
document.getElementById('skip-back-btn').addEventListener('click', () => jumpTo(currentPlayingIndex - 10));
document.getElementById('rewind-btn').addEventListener('click',    () => jumpTo(currentPlayingIndex - 1));
document.getElementById('forward-btn').addEventListener('click',   () => jumpTo(currentPlayingIndex + 1));
document.getElementById('skip-fwd-btn').addEventListener('click',  () => jumpTo(currentPlayingIndex + 10));

function jumpTo(idx) {
  if (!lastResult.length) return;
  idx = Math.max(0, Math.min(idx, lastResult.length - 1));
  currentPlayingIndex = idx;
  if (isPlaying) {
    startPlayback(lastResult, idx);
  } else {
    selectNote(idx, lastResult, { scroll: true });
    updateSeekUI(idx);
  }
}

// ── Seek slider ─────────────────────────────────────────────────────────
seekSlider.addEventListener('input', () => {
  const idx = parseInt(seekSlider.value, 10);
  if (isNaN(idx)) return;
  // While dragging, just preview (don't restart audio yet)
  selectNote(idx, lastResult, { scroll: true });
  updateSeekUI(idx);
});
seekSlider.addEventListener('change', () => {
  const idx = parseInt(seekSlider.value, 10);
  if (isNaN(idx)) return;
  currentPlayingIndex = idx;
  if (isPlaying) startPlayback(lastResult, idx);
});

function updateSeekUI(idx) {
  if (!lastResult.length) return;
  seekSlider.value = idx;
  seekCurrent.textContent = `#${idx + 1}`;
  const pct = (idx / Math.max(1, lastResult.length - 1)) * 100;
  seekSlider.style.setProperty('--seek-pct', pct + '%');
}

// Live BPM — restart from current note with new tempo
tempoSlider.addEventListener('input', () => {
  valBpm.textContent = tempoSlider.value;
  if (isPlaying) {
    const idx = currentPlayingIndex;
    stopPlayback(false);   // stop without resetting position
    startPlayback(lastResult, idx);
  }
});

function setPlaybackUI(state) {   // 'playing' | 'paused' | 'stopped'
  playBtn.classList.toggle('hidden',  state === 'playing');
  pauseBtn.classList.toggle('hidden', state !== 'playing');
  stopBtn.classList.toggle('hidden',  state === 'stopped');
}

// Rolling scheduler — only queues notes ~0.5s ahead so we never create
// thousands of AudioNodes at once (which silently fails in browsers for
// pieces like Summer with 1400+ notes).
let schedulerTid = null;
let schedNextIdx = 0;
let schedNextTime = 0;
let schedQSec = 0;
let schedVolume = 0;

function startPlayback(notes, fromIndex = 0) {
  // tear down previous audio without resetting position
  stopRequested = true;
  activeTimeouts.forEach(clearTimeout);
  activeTimeouts = [];
  if (schedulerTid) { clearTimeout(schedulerTid); schedulerTid = null; }
  if (audioCtx && audioCtx.state !== 'closed') {
    try { audioCtx.close(); } catch (_) {}
    audioCtx = null;
  }

  const ctx    = getAudioCtx();
  const bpm    = parseInt(tempoSlider.value, 10);
  schedVolume  = parseInt(volSlider.value, 10) / 100 * 0.45;
  schedQSec    = 60 / bpm;

  isPlaying     = true;
  isPaused      = false;
  stopRequested = false;
  currentPlayingIndex = fromIndex;
  setPlaybackUI('playing');

  schedNextIdx  = fromIndex;
  schedNextTime = ctx.currentTime + 0.08;

  schedulerTick(notes);
}

const SCHED_AHEAD = 0.5;   // queue up to 0.5s of audio ahead
const SCHED_TICK  = 60;    // ms between scheduler iterations

function schedulerTick(notes) {
  if (stopRequested || !audioCtx) return;
  const ctx = audioCtx;

  while (schedNextIdx < notes.length &&
         schedNextTime < ctx.currentTime + SCHED_AHEAD) {
    const i = schedNextIdx;
    const note = notes[i];
    const durSec = note.duration * schedQSec;

    if (!note.is_rest) {
      try {
        playViolinNote(ctx, midiToHz(note.midi_pitch), schedNextTime, durSec * 0.92, schedVolume);
      } catch (e) { console.warn('Audio error on note', i, e); }
    }

    // UI highlight (wall-clock setTimeout)
    const delay = Math.max(0, (schedNextTime - ctx.currentTime) * 1000);
    activeTimeouts.push(setTimeout(() => {
      if (!stopRequested) highlightNote(i);
    }, delay));

    schedNextTime += durSec;
    schedNextIdx++;
  }

  if (schedNextIdx < notes.length) {
    schedulerTid = setTimeout(() => schedulerTick(notes), SCHED_TICK);
  } else {
    // Last note scheduled — set auto-stop at the end
    const endDelay = Math.max(0, (schedNextTime - ctx.currentTime) * 1000);
    activeTimeouts.push(setTimeout(() => {
      if (!stopRequested) stopPlayback(true);
    }, endDelay));
  }
}

function pausePlayback() {
  if (!isPlaying) return;
  stopRequested = true;
  isPlaying  = false;
  isPaused   = true;
  // Re-show past cards now that playback isn't active
  if (nvStrip) nvStrip.querySelectorAll('.nv-past').forEach(c => c.classList.remove('nv-past'));
  activeTimeouts.forEach(clearTimeout);
  activeTimeouts = [];
  if (schedulerTid) { clearTimeout(schedulerTid); schedulerTid = null; }
  if (audioCtx && audioCtx.state !== 'closed') {
    try { audioCtx.close(); } catch (_) {}
    audioCtx = null;
  }
  setPlaybackUI('paused');
  // keep selectNote at currentPlayingIndex — don't reset
}

function stopPlayback(resetPosition = true) {
  stopRequested = true;
  isPlaying  = false;
  isPaused   = false;
  if (nvStrip) nvStrip.querySelectorAll('.nv-past').forEach(c => c.classList.remove('nv-past'));
  activeTimeouts.forEach(clearTimeout);
  activeTimeouts = [];
  if (schedulerTid) { clearTimeout(schedulerTid); schedulerTid = null; }
  if (audioCtx && audioCtx.state !== 'closed') {
    try { audioCtx.close(); } catch (_) {}
    audioCtx = null;
  }
  setPlaybackUI('stopped');
  if (resetPosition) {
    currentPlayingIndex = 0;
    if (lastResult.length) selectNote(0, lastResult, { scroll: false });
  }
}

const FINGER_NAMES = { 0: 'Open', 1: 'Index', 2: 'Middle', 3: 'Ring', 4: 'Pinky' };

function highlightNote(index) {
  currentPlayingIndex = index;
  selectNote(index, lastResult, { scroll: true });
}

function clearHighlight() {
  tbody.querySelectorAll('tr.is-active').forEach(r => r.classList.remove('is-active'));
}

// ── Error helpers ─────────────────────────────────────────────────────────
function showError(msg) { errorMsg.textContent = msg; errorMsg.classList.remove('hidden'); }
function hideError()    { errorMsg.classList.add('hidden'); errorMsg.textContent = ''; }

// ── Auto-solve on load ────────────────────────────────────────────────────
solveBtn.click();

// ── Bitmidi search ────────────────────────────────────────────────────────
const songSearchInput = document.getElementById('song-search-input');
const songSearchBtn   = document.getElementById('song-search-btn');
const searchStatus    = document.getElementById('search-status');
const searchResults   = document.getElementById('search-results');

function setSearchStatus(msg, isError = false) {
  searchStatus.textContent = msg;
  searchStatus.classList.toggle('error', isError);
}

async function handleSearch() {
  const q = songSearchInput.value.trim();
  if (!q) return;
  songSearchBtn.disabled = true;
  searchResults.innerHTML = '';
  setSearchStatus('Searching…');
  try {
    const data = await fetch(`/api/search/?q=${encodeURIComponent(q)}`).then(r => r.json());
    if (!data.ok) { setSearchStatus(data.error || 'Search failed', true); return; }
    if (!data.results.length) { setSearchStatus('No results'); return; }
    setSearchStatus(`${data.total ?? data.results.length} results — click one to import`);
    for (const result of data.results) {
      const btn = document.createElement('button');
      btn.className = 'search-result-btn';
      btn.textContent = result.title;
      btn.title = result.url;
      btn.addEventListener('click', () => handleImport(result.url, result.title, btn));
      searchResults.appendChild(btn);
    }
  } catch (_) {
    setSearchStatus('Network error', true);
  } finally {
    songSearchBtn.disabled = false;
  }
}

async function handleImport(url, title, btn) {
  searchResults.querySelectorAll('.search-result-btn').forEach(b => b.disabled = true);
  btn.classList.add('loading');
  setSearchStatus('Importing…');
  try {
    const data = await fetch('/api/import/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, title }),
    }).then(r => r.json());

    if (!data.ok) {
      setSearchStatus(data.error || 'Import failed', true);
      searchResults.querySelectorAll('.search-result-btn').forEach(b => { b.disabled = false; });
      btn.classList.remove('loading');
      return;
    }

    document.querySelectorAll('.example-btn').forEach(b => b.classList.remove('active'));
    seqInput.value = data.sequence.map(([p, d]) =>
      p === null ? `rest ${d}` : `${p} ${d}`
    ).join('\n');
    if (data.bpm) { tempoSlider.value = data.bpm; valBpm.textContent = data.bpm; }
    saveRecent({ label: data.label, bpm: data.bpm, sequence: data.sequence, url });
    searchResults.querySelectorAll('.search-result-btn').forEach(b => { b.disabled = false; });
    btn.classList.remove('loading');
    setSearchStatus(`Loaded: ${data.label} (${data.note_count} notes)`);
    solveBtn.click();
  } catch (_) {
    setSearchStatus('Network error', true);
    searchResults.querySelectorAll('.search-result-btn').forEach(b => { b.disabled = false; });
    btn.classList.remove('loading');
  }
}

songSearchBtn.addEventListener('click', handleSearch);
songSearchInput.addEventListener('keydown', e => { if (e.key === 'Enter') handleSearch(); });

// ── Recently Played ───────────────────────────────────────────────────────
const RECENT_KEY = 'violin-recent';
const RECENT_MAX = 20;

function getRecent() {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); }
  catch (_) { return []; }
}

function saveRecent(entry) {
  let recent = getRecent().filter(r => r.url !== entry.url);
  recent.unshift(entry);
  if (recent.length > RECENT_MAX) recent.length = RECENT_MAX;
  localStorage.setItem(RECENT_KEY, JSON.stringify(recent));
  renderRecent();
}

function deleteRecent(url) {
  const recent = getRecent().filter(r => r.url !== url);
  localStorage.setItem(RECENT_KEY, JSON.stringify(recent));
  renderRecent();
}

function loadRecentEntry(entry) {
  document.querySelectorAll('.example-btn').forEach(b => b.classList.remove('active'));
  seqInput.value = entry.sequence.map(([p, d]) =>
    p === null ? `rest ${d}` : `${p} ${d}`
  ).join('\n');
  if (entry.bpm) { tempoSlider.value = entry.bpm; valBpm.textContent = entry.bpm; }
  solveBtn.click();
}

function renderRecent() {
  const section = document.getElementById('section-recent');
  const list    = document.getElementById('recent-list');
  const recent  = getRecent();

  if (!recent.length) { section.style.display = 'none'; return; }

  section.style.display = '';
  list.innerHTML = '';

  for (const entry of recent) {
    const row = document.createElement('div');
    row.className = 'recent-row';

    const play = document.createElement('button');
    play.className = 'example-btn example-btn-piece recent-play-btn';
    play.innerHTML = `<span class="example-btn-label">${entry.label}</span>`
                   + `<span class="example-btn-meta">${entry.bpm} BPM</span>`;
    play.addEventListener('click', () => loadRecentEntry(entry));

    const del = document.createElement('button');
    del.className = 'recent-del-btn';
    del.title = 'Remove';
    del.textContent = '×';
    del.addEventListener('click', () => deleteRecent(entry.url));

    row.appendChild(play);
    row.appendChild(del);
    list.appendChild(row);
  }
}

renderRecent();
