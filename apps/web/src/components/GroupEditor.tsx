/**
 * The member editor for one notebook group (slice-1 commit D). DRAFT
 * semantics throughout (recorded ruling §3): every edit lives in local state
 * and ONE explicit Apply commits through the store — keystrokes never issue
 * worker queries. Validation runs the SAME admission the store enforces
 * (validateNotebookGroup), surfaced inline before Apply is attempted.
 *
 * Authoring surfaces: the narrow token/affix shorthand (`wolf`, `wolf*`,
 * `*wolf` — lib/member-edit.ts) and ordered phrase CHIPS (one word per chip;
 * quote-to-phrase tokenization is deferred). Per-member match toggles flip
 * case/diacritics between folded ("any") and sensitive ("exact") — the UI
 * says "exact", the data stays `sensitive|folded`.
 */

import { useState } from 'react';
import type { GroupMember, MatchMode } from '@texttrends/core';
import { useApp } from '../lib/store-instance.ts';
import { compileMemberInput, compilePhraseChips, describeMember } from '../lib/member-edit.ts';
import { validateNotebookGroup, type NotebookGroupV1 } from '../lib/notebook.ts';

const btn = {
  font: 'inherit',
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--text-xs)',
  color: 'var(--fg)',
  background: 'none',
  border: '1px solid var(--rule)',
  cursor: 'pointer',
  padding: '0 0.5ch',
} as const;

const flipCase = (m: MatchMode): MatchMode =>
  ({ ...m, case: m.case === 'folded' ? 'sensitive' : 'folded' });
const flipDiacritics = (m: MatchMode): MatchMode =>
  ({ ...m, diacritics: m.diacritics === 'folded' ? 'sensitive' : 'folded' });

function MatchToggles({ match, name, onChange }: {
  match: MatchMode;
  /** The owning member's description — qualifies the accessible names. */
  name: string;
  onChange: (m: MatchMode) => void;
}) {
  return (
    <span style={{ display: 'inline-flex', gap: '0.5ch' }}>
      <button
        type="button" style={btn}
        aria-label={`Exact case: ${name}`}
        aria-pressed={match.case === 'sensitive'}
        title={match.case === 'sensitive' ? 'matching exact case — click for any case' : 'matching any case — click for exact case'}
        onClick={() => onChange(flipCase(match))}
      >Aa</button>
      <button
        type="button" style={btn}
        aria-label={`Exact accents: ${name}`}
        aria-pressed={match.diacritics === 'sensitive'}
        title={match.diacritics === 'sensitive' ? 'matching exact accents — click for any accents' : 'matching any accents — click for exact accents'}
        onClick={() => onChange(flipDiacritics(match))}
      >â</button>
    </span>
  );
}

export function GroupEditor({ group, onClose }: { group: NotebookGroupV1; onClose: () => void }) {
  const setGroupMembers = useApp((s) => s.setGroupMembers);
  const [members, setMembers] = useState<readonly GroupMember[]>(group.members);
  const [countOverlaps, setCountOverlaps] = useState(group.countOverlaps);
  const [addText, setAddText] = useState('');
  const [addMatch, setAddMatch] = useState<MatchMode>({ case: 'folded', diacritics: 'folded' });
  const [chips, setChips] = useState<readonly string[]>([]);
  const [chipText, setChipText] = useState('');
  const [error, setError] = useState<string | null>(null);

  const newId = () => crypto.randomUUID();
  const push = (compiled: ReturnType<typeof compileMemberInput>): boolean => {
    if (!compiled.ok) { setError(compiled.error); return false; }
    setMembers((m) => [...m, compiled.member]);
    setError(null);
    return true;
  };

  const apply = () => {
    const draft: NotebookGroupV1 = { ...group, members, countOverlaps };
    try {
      validateNotebookGroup(draft); // the SAME admission the store enforces
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return;
    }
    setGroupMembers(group.id, members, countOverlaps);
    onClose();
  };

  return (
    <div
      role="group"
      aria-label={`Edit members: ${group.name}`}
      style={{
        margin: '2px 0 var(--space-2) calc(var(--space-2) + 18px)',
        padding: 'var(--space-2)',
        border: '1px solid var(--rule)',
        fontFamily: 'var(--font-mono)',
        fontSize: 'var(--text-xs)',
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-1)',
      }}
    >
      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '2px' }}>
        {members.map((m) => {
          const label = describeMember(m);
          return (
            <li key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
              <span style={{ minWidth: '16ch' }}>{label}</span>
              <MatchToggles
                match={m.match}
                name={label}
                onChange={(match) => setMembers((all) => all.map((x) => (x.id === m.id ? { ...x, match } : x)))}
              />
              <button
                type="button" style={btn}
                aria-label={`Remove member ${label}`}
                onClick={() => setMembers((all) => all.filter((x) => x.id !== m.id))}
              >remove</button>
            </li>
          );
        })}
      </ul>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (push(compileMemberInput(addText, addMatch, newId))) setAddText('');
        }}
        style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}
      >
        <input
          value={addText}
          onChange={(e) => setAddText(e.target.value)}
          aria-label={`Add member to ${group.name} — wolf, wolf* (prefix) or *wolf (suffix)`}
          placeholder="alias, wolf* or *wolf"
          style={{ font: 'inherit', background: 'transparent', color: 'var(--fg)', border: 'none', borderBottom: '1px solid var(--rule)', width: '22ch' }}
        />
        <MatchToggles match={addMatch} name="new member" onChange={setAddMatch} />
        <button type="submit" style={btn}>add</button>
      </form>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const word = chipText.trim();
          if (word === '') return;
          if (/\s/u.test(word)) { setError('one word per chip — add each phrase word separately'); return; }
          setChips((c) => [...c, word]);
          setChipText('');
          setError(null);
        }}
        style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', flexWrap: 'wrap' }}
      >
        {chips.map((c, i) => (
          <span key={`${c}:${i}`} style={{ border: '1px solid var(--rule)', padding: '0 0.5ch' }}>
            {c}{' '}
            <button
              type="button" style={{ ...btn, border: 'none' }}
              aria-label={`Remove phrase word ${c}`}
              onClick={() => setChips((all) => all.filter((_, j) => j !== i))}
            >×</button>
          </span>
        ))}
        <input
          value={chipText}
          onChange={(e) => setChipText(e.target.value)}
          aria-label={`Add phrase word to ${group.name} (ordered)`}
          placeholder="phrase word…"
          style={{ font: 'inherit', background: 'transparent', color: 'var(--fg)', border: 'none', borderBottom: '1px solid var(--rule)', width: '14ch' }}
        />
        <button type="submit" style={btn}>add word</button>
        <button
          type="button" style={btn}
          aria-label={`Add phrase to ${group.name}`}
          disabled={chips.length < 2}
          onClick={() => {
            if (push(compilePhraseChips(chips, addMatch, newId))) setChips([]);
          }}
        >add phrase</button>
      </form>
      <label style={{ display: 'flex', alignItems: 'center', gap: '0.75ch', cursor: 'pointer' }}>
        <input
          type="checkbox"
          checked={countOverlaps}
          onChange={(e) => setCountOverlaps(e.target.checked)}
          aria-describedby={`overlap-help-${group.id}`}
        />
        count overlapping matches separately
      </label>
      <p id={`overlap-help-${group.id}`} style={{ margin: 0, color: 'var(--fg-muted)' }}>
        off: overlapping aliases/phrases count once — on: every member match
        counts, which can intentionally double-count overlapping evidence
      </p>
      {error && <p role="alert" style={{ color: 'var(--accent-text)', margin: 0 }}>{error}</p>}
      <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
        <button type="button" style={btn} aria-label={`Apply changes to ${group.name}`} onClick={apply}>Apply</button>
        <button type="button" style={btn} aria-label={`Cancel editing ${group.name}`} onClick={onClose}>Cancel</button>
      </div>
    </div>
  );
}
