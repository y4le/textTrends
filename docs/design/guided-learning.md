# Guided learning

The tour teaches one round trip: a shown term has positions, a position opens
source, and returning reveals that same position in the chart cursor. Four
pull-only Help notes cover Terms and the notebook, Reading a trend, The reading
strip, and Compare a passage. Method notes and useful empty states remain
ordinary product responsibilities.

## Product boundary

The seven cards are Welcome, Terms, ordered axis, mark, source, return, and
Finish. The return card first offers Go back inside Reader, then reveals the
chart cursor and a Finish action after the qualified close. Native Reader close
from the source card also reveals that return beat; it cannot skip the payoff.
The scripts live once in `apps/web/src/lib/guide/registry.ts`, with titles,
synopses, and contextual Help copy in `help-content.ts`.

The overall tour starts from workbench Help or its explicit in-flow invitation.
Reader Help explains that the user must return to the workbench; Speed Help
requires leaving Speed first. Ready text and a shown term are prerequisites.
Pending/superseded dispersion permits early scenes; a ready zero-hit result or
failed distribution gives a direct remedy rather than a stranded tour.
Samples are separately chosen acquisition actions. The guide never imports,
creates a special corpus, changes terms, stages a range, or performs analysis.

Notes always reopen at the beginning and have manual Next/Done controls.
There is no autostart, arrival/dwell trigger, telemetry, curriculum, badge,
or per-note completion state. Inputs/Trends empty states and method tooltips
remain useful without the guide engine. Compare's no-range state and Matches'
no-shown-terms state can link to a note; a no-occurrences state is distinct.

## Ownership and target selection

`components/guide/GuideProvider.tsx` owns a React session over the pure reducer
in `lib/guide/session.ts`. Pure guide modules cannot import the store, worker,
React, or components. The lazy registry contains plain copy, identifiers,
readiness, and intents. Product components publish only semantic anchors and
native-activation facts.

The closed staging union permits place replacement, Reader open, and Reader
close. No research-edit intent exists. Guide state is absent from `AppState`,
workspace serialization, and URL state. Opening Reader may perform the source
request its ordinary product action requires; no guide-attributable trend,
dispersion, Matches, inventory, frequency, keyness, Company, Destinations, or
occurrence-step request is allowed.

`resolveGuideTarget` reads snapshot-matched resident dispersion directly:

1. Prefer a positive exact track by largest total, then shown notebook order.
2. Choose its longest ready text with an occurrence and known positive extent;
   break ties by declared order.
3. Choose the occurrence nearest the text midpoint, breaking ties by lower token.
4. If no exact track qualifies, apply the same rules to positive density tracks
   and nonempty bucket midpoints, retaining a position claim and bucket count.
5. Report absent, stale, failed, or missing-extent data honestly.

CSR projection keeps the resident ready-document axis. Density midpoints match
`barcodeTracks`, including the final bucket's actual document end. Do not
materialize a second full occurrence view. Gesture copy depends on live anchor
facts: minimized takes precedence over coarse; missing anchors make no native
activation claim. Card actions provide the fallback at every pointer class.

## Navigation and restoration

The Mark scene accepts only its resolved Reader intent or a live exact barcode
open in the same snapshot. It adopts the actual native target before narrating
source. Unrelated opens end the guide without undoing navigation.

A qualified open records Reader layer id, exact parent-id prefix, parent place,
and target. A consumable close moves exactly from that terminal Reader to its
remembered parent with no Reader and unchanged parent place. Paging, reference
stepping, and Atlas movement preserve the layer. Every other navigation shape
ends the guide without restoration; there is no second history implementation.

Place staging is synchronous. Reader close requests asynchronous history
traversal and must earn its recorded fence before advancement/restoration.
Back to where I was closes Reader if necessary, waits for the qualified close,
then replaces the origin place and restores focus. Close restoration has a
1.2-second deadline and cleans timers on every outcome.

App closes modal Help before starting a guide and waits for the existing
utility close-settlement path to make the root interactive. If the three-frame
bound expires, it abandons start rather than placing a card behind an inert
root. Direct guide links capture their own focus candidate. The provider does
not manipulate Help or inertness itself.

## Presentation and accessibility

One fixed non-modal dialog card uses a 26rem maximum measure, a declared
block-start/block-end side, internal scrolling, safe-area/dock clearance, and
44px actions. Block-start keeps Terms visible; block-end clears the active
surface's dock. The card sits above Reader and below modal utilities without
trapping focus or adding a backdrop.

Semantic `data-guide-anchor` values identify Terms, trend plate, dispersion,
chart cursor, prose, reading footer, and comparison sides. One lookup at step
entry can scroll a target into nearest view. Missing anchors yield unanchored
copy without blocking progress. There is no structure selector, continuous
geometry observer, or collision engine. CSS highlights one visible publisher
per active semantic anchor, independent of its component filename.

Focus moves to the heading on step/phase revision; Replay increments revision.
Escape exits only from within the card. Global Reader/Find/range/utility keys
retain ownership. Required actions are native buttons. One polite status names
navigation changes; reduced motion removes animation and smooth scroll.
Exit focus falls through the originating control, global Help, and origin
place heading.

## Stored invitation and verification

The exact `texttrends/guide/1` record contains only `v`, `tourSeenVersion`, and
`dismissedInvitationVersion`. Finish records the seen version; invitation
Start/Not now records dismissal. Either suppresses that version's invitation.
Malformed or unavailable storage falls back safely. Full reset clears the key
through the shared owned-key registry. No source names, terms, document ids,
corpus sizes, passages, or active step are stored.

Unit gates cover reducer transitions, target tie cases and density agreement,
copy truth, closed staging, storage/reset, and a complete tour with no durable
semantic writes or linked-selection changes. Browser gates cover native/card
actions, source→cursor return, foreign Back, restore timeout, lazy launch,
staleness, no forbidden queries, one visible effective anchor, and compact
WebKit. Moderated novice comprehension and physical screen-reader testing
remain separate validation work, not claims inferred from automated tests.
