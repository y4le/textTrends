"""Generate .yalethomas/card.svg.

A 3x render of the textTrends corpus footer -- trend graph, occurrence
barcode, reading cursor and one line of source text on a shared token axis --
reading Dracula with the query `sunlight`.

Geometry mirrors COMPACT_FINE in apps/web/src/lib/footer-metrics.ts (the
layout the app uses below 600 CSS px). Trend bins mirror DEFAULT_TREND_BINS
(40 per doc, rate). All data is read from text/ at generation time.

Motion is CSS, not SMIL: the landing page drives hover playback through
document.getAnimations(), which does not expose declarative SMIL. Every
animated element shares one duration and zero delay so they finish in
lockstep when the page lets the cycle run out.
"""
import re, html, unicodedata
from pathlib import Path

ROOT  = Path(__file__).resolve().parent.parent
SRC   = ROOT / 'text/standard-ebooks/02 - Dracula - Bram Stoker.txt'
OUT   = ROOT / '.yalethomas/card.svg'
TERM  = 'sunlight'
TITLE = 'Dracula'
REST  = 4          # 0-based occurrence shown at rest and at t=0

W, H       = 1618, 1000
X0, AXIS   = 84.0, 1450.0
S          = 3                       # app CSS px -> card px
FOOTER_TOP = 577.0
WORD_BASE  = 361.0

# COMPACT_FINE, scaled
BORDER, PAD          = 1*S, 4*S
PASSAGE_H, LANE_GAP  = 20*S, 3*S
STATUS_H             = 14*S
SERIES_H, TOP_PAD    = 20*S, 2*S
BAND_GAP, TRACK_H    = 3*S, 5*S
PROGRESS_H, CURSOR_W = 2*S, 1*S
TEXT_SM, LINE_H      = 13*S, 20*S
TEXT_XS              = 11*S
ADVANCE              = TEXT_SM * 0.6      # ui-monospace advance
BUDGET_ADVANCE       = TEXT_SM * 0.615    # conservative, so nothing clips
BINS                 = 40                 # DEFAULT_TREND_BINS.count
STEP                 = 0.9                # seconds per occurrence

y = FOOTER_TOP + BORDER + PAD
PASSAGE_Y = y;  y += PASSAGE_H + LANE_GAP
STATUS_Y  = y;  y += STATUS_H + LANE_GAP
STRIP_Y   = y
STRIP_H   = SERIES_H + BAND_GAP + TRACK_H
BARCODE_Y = STRIP_Y + SERIES_H + BAND_GAP
FOOTER_H  = BORDER + 2*PAD + PASSAGE_H + LANE_GAP + STATUS_H + LANE_GAP + STRIP_H

raw  = unicodedata.normalize('NFC', SRC.read_text(encoding='utf-8')).replace('﻿', '')
toks = list(re.finditer(r"[A-Za-z']+", raw))
N    = len(toks)
hits = [i for i, m in enumerate(toks) if m.group(0).lower() == TERM]

TERM_W = len(TERM) * ADVANCE
LANE_END = X0 + AXIS

def fitted(i):
    """Source context sized to the room left of and right of the match, cut on
    word boundaries so the line never runs off either edge of the lane."""
    m = toks[i]
    # Clamp the match box into the lane; at the corpus edges the app's own
    # passage scroll clamps the same way.
    cx = min(max(X0 + i/N*AXIS, X0 + TERM_W/2), LANE_END - TERM_W/2)
    left_px, right_px = cx - TERM_W/2 - X0, LANE_END - (cx + TERM_W/2)

    before = re.sub(r'\s+', ' ', raw[max(0, m.start()-600):m.start()])
    after  = re.sub(r'\s+', ' ', raw[m.end():m.end()+600])
    before = before[-max(0, int(left_px / BUDGET_ADVANCE)):] if left_px > 0 else ''
    after  = after[:max(0, int(right_px / BUDGET_ADVANCE))] if right_px > 0 else ''
    # Drop the partial word each cut leaves at the outer edge.
    if before and not before[0].isspace() and ' ' in before:
        before = before[before.index(' '):]
    if after and not after[-1].isspace() and ' ' in after:
        after = after[:after.rindex(' ') + 1]
    return cx, before, m.group(0), after

order = hits[REST:] + hits[:REST]
stops = []
for i in order:
    cx, before, term, after = fitted(i)
    stops.append(dict(i=i, x=X0 + i/N*AXIS, cx=cx, ratio=i/N,
                      pct=round((i+1)/N*100), before=before, term=term, after=after))

counts = [0]*BINS
for i in hits:
    counts[min(BINS-1, int(i/N*BINS))] += 1
peak = max(counts)
plot_top, plot_bot = STRIP_Y + TOP_PAD, STRIP_Y + SERIES_H
spark = ' '.join(
    f"{'M' if b == 0 else 'L'}{X0 + (b+0.5)/BINS*AXIS:.1f},"
    f"{plot_bot - counts[b]/peak*(plot_bot-plot_top):.1f}" for b in range(BINS))

n = len(stops)
DUR = round(STEP*n, 2)
def at(k):
    return f'{k*100/n:.4f}%'

e = html.escape
TINT_Y  = PASSAGE_Y + (PASSAGE_H - LINE_H)/2
BASE_Y  = TINT_Y + LINE_H*0.72
UNDER_Y = TINT_Y + LINE_H
STATUS_BASE = STATUS_Y + STATUS_H/2 + TEXT_XS*0.36

# ---- keyframes: one per occurrence, plus cursor and progress ---------------
frames = []
for k in range(n):
    stages = [f'  0% {{ opacity: {1 if k == 0 else 0}; }}']
    if k > 0:
        stages.append(f'  {at(k)} {{ opacity: 1; }}')
    stages.append(f'  {at(k+1)} {{ opacity: 0; }}')
    stages.append(f'  100% {{ opacity: {1 if k == 0 else 0}; }}')
    frames.append(f'@keyframes tt-s{k} {{\n' + '\n'.join(stages) + '\n}')

cursor = '\n'.join(
    f'  {at(k)} {{ transform: translateX({s["x"] - CURSOR_W/2:.1f}px); }}'
    for k, s in enumerate(stops))
frames.append(f'@keyframes tt-cursor {{\n{cursor}\n'
              f'  100% {{ transform: translateX({stops[0]["x"] - CURSOR_W/2:.1f}px); }}\n}}')

progress = '\n'.join(
    f'  {at(k)} {{ transform: scaleX({s["ratio"]:.4f}); }}' for k, s in enumerate(stops))
frames.append(f'@keyframes tt-progress {{\n{progress}\n'
              f'  100% {{ transform: scaleX({stops[0]["ratio"]:.4f}); }}\n}}')

step_rules = '\n'.join(f'    .tt-s{k} {{ animation-name: tt-s{k}; }}' for k in range(n))

def passage(s, cls=''):
    left, right = s['cx'] - TERM_W/2, s['cx'] + TERM_W/2
    return f'''      <g{cls}>
        <rect class="tt-tint" x="{left:.1f}" y="{TINT_Y:.1f}" width="{TERM_W:.1f}" height="{LINE_H}" />
        <rect class="tt-mark" x="{left:.1f}" y="{UNDER_Y - 2*S:.1f}" width="{TERM_W:.1f}" height="{2*S}" />
        <rect class="tt-node" x="{left:.1f}" y="{UNDER_Y:.1f}" width="{TERM_W:.1f}" height="{S}" />
        <text class="tt-mono tt-passage" xml:space="preserve" x="{left:.1f}" y="{BASE_Y:.1f}" text-anchor="end">{e(s['before'])}</text>
        <text class="tt-mono tt-passage" x="{s['cx']:.1f}" y="{BASE_Y:.1f}" text-anchor="middle" textLength="{TERM_W:.1f}" lengthAdjust="spacingAndGlyphs">{e(s['term'])}</text>
        <text class="tt-mono tt-passage" xml:space="preserve" x="{right:.1f}" y="{BASE_Y:.1f}" text-anchor="start">{e(s['after'])}</text>
      </g>'''

def status(s):
    return f'{TITLE} · token {s["i"]+1:,} of {N:,} · {s["pct"]}% of corpus'

o = []
o.append(f'''<svg
  xmlns="http://www.w3.org/2000/svg"
  id="tt-card"
  viewBox="0 0 {W} {H}"
  role="img"
  aria-labelledby="tt-card-title tt-card-description"
>
  <title id="tt-card-title">textTrends</title>
  <desc id="tt-card-description">
    The textTrends corpus footer reading Bram Stoker&apos;s Dracula. A trend
    graph, an occurrence barcode, a reading cursor and one line of source text
    share a single token axis. The query is sunlight, which occurs {len(hits)}
    times in {N:,} tokens. The cursor steps from occurrence to occurrence; the
    source line slides so the matched word stays directly above its own mark,
    and the reading-position readout follows it.
  </desc>

  <style>
    #tt-card {{
      color-scheme: light dark;
      --fg: light-dark(#1c1913, #e8e2d5);
      --fg-muted: light-dark(#6e6754, #9a937f);
      --rule: light-dark(#c9c0aa, #454038);
      --rule-strong: light-dark(#948a73, #746b57);
      --series-1: light-dark(#1f68bc, #30aff8);
      --tt-cycle: {DUR}s;
    }}
    #tt-card[data-color-scheme="light"] {{ color-scheme: only light; }}
    #tt-card[data-color-scheme="dark"] {{ color-scheme: only dark; }}

    .tt-word {{
      fill: var(--fg);
      font-family: Geist, Inter, 'Helvetica Neue', Arial, sans-serif;
      font-size: 236px;
      font-weight: 720;
      letter-spacing: -0.06em;
    }}
    .tt-mono {{
      font-family: ui-monospace, 'SF Mono', 'Cascadia Mono', 'JetBrains Mono', monospace;
      font-kerning: none;
    }}
    .tt-passage {{ font-size: {TEXT_SM}px; fill: var(--fg); }}
    .tt-status {{ font-size: {TEXT_XS}px; fill: var(--fg-muted); }}
    .tt-rule {{ fill: var(--rule); }}
    .tt-mark {{ fill: var(--series-1); }}
    .tt-node {{ fill: var(--rule-strong); }}
    .tt-tint {{ fill: var(--series-1); opacity: 0.22; }}
    .tt-cursor, .tt-progress {{ fill: var(--fg); }}
    .tt-track {{ fill: var(--fg); opacity: 0.14; }}
    .tt-spark {{ fill: none; stroke: var(--series-1); stroke-width: {S}px; }}

    /* One duration, one phase, no delay: the landing page ends playback by
     * letting the current iteration finish, and every element has to arrive
     * at the resting frame together. */
    .tt-step, .tt-cursor, .tt-progress {{
      animation-duration: var(--tt-cycle);
      animation-timing-function: step-end;
      animation-iteration-count: infinite;
    }}
{step_rules}
    .tt-cursor {{ animation-name: tt-cursor; }}
    .tt-progress {{
      animation-name: tt-progress;
      transform-box: fill-box;
      transform-origin: left center;
      transform: scaleX({stops[0]["ratio"]:.4f});
    }}

{chr(10).join('    ' + line for frame in frames for line in frame.splitlines())}

    .tt-still {{ display: none; }}
    @media (prefers-reduced-motion: reduce) {{
      .tt-motion {{ display: none; }}
      .tt-still {{ display: inline; }}
    }}
  </style>

  <text class="tt-word" x="{W/2}" y="{WORD_BASE}" text-anchor="middle" aria-hidden="true">textTrends</text>

  <g aria-hidden="true">
    <rect class="tt-rule" x="{X0}" y="{FOOTER_TOP}" width="{AXIS}" height="{BORDER}" />
    <path class="tt-spark" d="{spark}" />
    <rect class="tt-track" x="{X0}" y="{STRIP_Y}" width="{AXIS}" height="{PROGRESS_H}" />''')
for i in hits:
    o.append(f'    <rect class="tt-mark" x="{X0 + i/N*AXIS:.1f}" y="{BARCODE_Y}" width="{S}" height="{TRACK_H}" />')
o.append('  </g>')

o.append(f'''  <g class="tt-motion" aria-hidden="true">
    <rect class="tt-progress" x="{X0}" y="{STRIP_Y}" width="{AXIS}" height="{PROGRESS_H}" />
    <rect class="tt-cursor" x="0" y="{STRIP_Y}" width="{CURSOR_W}" height="{STRIP_H}"
          transform="translate({stops[0]['x'] - CURSOR_W/2:.1f} 0)" />
  </g>

  <g class="tt-motion" aria-hidden="true">''')
for k, s in enumerate(stops):
    o.append(passage(s, f' class="tt-step tt-s{k}" opacity="{1 if k == 0 else 0}"'))
o.append('  </g>')

o.append('  <g class="tt-motion" aria-hidden="true">')
for k, s in enumerate(stops):
    o.append(f'    <text class="tt-mono tt-status tt-step tt-s{k}" x="{W/2}" '
             f'y="{STATUS_BASE:.1f}" text-anchor="middle" '
             f'opacity="{1 if k == 0 else 0}">{e(status(s))}</text>')
o.append('  </g>')

s0 = stops[0]
o.append(f'''  <g class="tt-still" aria-hidden="true">
    <rect class="tt-progress" x="{X0}" y="{STRIP_Y}" width="{s0['ratio']*AXIS:.1f}" height="{PROGRESS_H}" style="animation: none; transform: none;" />
    <rect class="tt-cursor" x="{s0['x'] - CURSOR_W/2:.1f}" y="{STRIP_Y}" width="{CURSOR_W}" height="{STRIP_H}" style="animation: none;" />
{passage(s0)}
    <text class="tt-mono tt-status" x="{W/2}" y="{STATUS_BASE:.1f}" text-anchor="middle">{e(status(s0))}</text>
  </g>
</svg>''')

svg = '\n'.join(o) + '\n'
OUT.write_text(svg, encoding='utf-8')
print(f'footer {FOOTER_H} card px = {FOOTER_H/S:g} app px | cycle {DUR}s, {n} steps')
print(f'{len(svg):,} bytes')
for k, s in enumerate(stops):
    print(f'  {k}: {s["pct"]:3d}%  left {len(s["before"]):2d}ch  right {len(s["after"]):2d}ch  '
          f'span {s["cx"]-TERM_W/2 - len(s["before"])*ADVANCE:7.1f} .. '
          f'{s["cx"]+TERM_W/2 + len(s["after"])*ADVANCE:7.1f}')
