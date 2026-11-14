// Phone mode's cards (docs/phone-mode-design.md, "What the person sees", items 4 to 6): a question with options and the
// person's own answer, a permission with Allow / Always allow / Deny, a plan with Approve / Keep planning. One card at a
// time, the oldest first. Every string on a card comes from Claude, a tool or an MCP server: it is shown as text only.
import { useState } from 'react';
import { questionAnswer, togglePick, permissionAnswer, planAnswer } from './phone-mode.js';

function QuestionCard({ card, busy, onAnswer }) {
  const [picks, setPicks] = useState({});
  const [missing, setMissing] = useState('');
  const set = (q, patch) => { setMissing(''); setPicks((p) => ({ ...p, [q]: { ...(p[q] || {}), ...patch } })); };
  const submit = () => {
    const r = questionAnswer(card, picks);
    if (r.missing) { setMissing(r.missing); return; }
    onAnswer(r.answer);
  };
  return (
    <>
      {card.questions.map((q) => {
        const p = picks[q.question] || {};
        return (
          <div key={q.index} className="phone-q">
            {q.header && <div className="ask-eyebrow ask-topic">{q.header}</div>}
            <div className="ask-question">{q.question}</div>
            {q.multiSelect && <div className="phone-hint">Pick any that apply</div>}
            <div className="ask-options">
              {q.options.map((o) => {
                const on = (p.labels || []).includes(o.label);
                return (
                  <button key={o.label} type="button" className={`ask-opt${on ? ' picked' : ''}`} aria-pressed={on} disabled={busy}
                    onClick={() => set(q.question, { labels: togglePick(p.labels, o.label, q.multiSelect) })}>
                    <span className="ask-opt-label">{on ? '✓ ' : ''}{o.label}</span>
                    {o.description && <span className="ask-opt-detail">{o.description}</span>}
                  </button>
                );
              })}
            </div>
            <textarea className="phone-own" rows={1} placeholder="Your own answer" aria-label={`Your own answer to: ${q.question}`}
              value={p.own || ''} disabled={busy} onChange={(e) => set(q.question, { own: e.target.value })} />
          </div>
        );
      })}
      {missing && <p className="ask-note" role="alert">Answer this one first: {missing}</p>}
      <div className="phone-actions">
        <button type="button" className="phone-btn primary" disabled={busy} onClick={submit}>Submit</button>
      </div>
    </>
  );
}

function PermissionCard({ card, busy, onAnswer }) {
  const [note, setNote] = useState('');
  const [showInput, setShowInput] = useState(false);
  const sentence = card.title || `Claude wants to use ${card.displayName || card.tool}`;
  return (
    <>
      <div className="ask-question">{sentence}</div>
      {card.description && <p className="phone-detail">{card.description}</p>}
      {card.mcpServer && <p className="phone-detail">From the {card.mcpServer} server</p>}
      {card.blockedPath && <p className="phone-detail">Path: {card.blockedPath}</p>}
      {card.reason && <p className="phone-detail">{card.reason}</p>}
      {typeof card.command === 'string' && card.command && <pre className="ask-context ask-code phone-command">{card.command}</pre>}
      {card.input && card.input !== '{}' && (
        showInput
          ? <pre className="ask-context ask-code">{card.input}</pre>
          : <button type="button" className="ask-link" onClick={() => setShowInput(true)}>Show the details</button>
      )}
      <textarea className="phone-own" rows={1} placeholder="Note to Claude (optional)" aria-label="Note to Claude"
        value={note} disabled={busy} onChange={(e) => setNote(e.target.value)} />
      <div className="phone-actions">
        <button type="button" className={`phone-btn${card.defaultToNo ? '' : ' primary'}`} disabled={busy}
          onClick={() => onAnswer(permissionAnswer(true, { note }))}>Allow</button>
        {card.canAlways && (
          <button type="button" className="phone-btn" disabled={busy}
            onClick={() => onAnswer(permissionAnswer(true, { always: true, note }))}>Always allow</button>
        )}
        <button type="button" className={`phone-btn${card.defaultToNo ? ' primary' : ''}`} disabled={busy}
          onClick={() => onAnswer(permissionAnswer(false, { note }))}>Deny</button>
      </div>
    </>
  );
}

function PlanCard({ card, busy, onAnswer }) {
  const [note, setNote] = useState('');
  return (
    <>
      <div className="ask-question">Claude has a plan</div>
      <pre className="ask-context phone-plan">{card.summary || '(the plan was empty)'}</pre>
      <textarea className="phone-own" rows={1} placeholder="What to change (for Keep planning)" aria-label="What to change in the plan"
        value={note} disabled={busy} onChange={(e) => setNote(e.target.value)} />
      <div className="phone-actions">
        <button type="button" className="phone-btn primary" disabled={busy} onClick={() => onAnswer(planAnswer(true))}>Approve</button>
        <button type="button" className="phone-btn" disabled={busy} onClick={() => onAnswer(planAnswer(true, { mode: 'acceptEdits' }))}>Approve, accept edits</button>
        <button type="button" className="phone-btn" disabled={busy} onClick={() => onAnswer(planAnswer(false, { note }))}>Keep planning</button>
      </div>
    </>
  );
}

const EYEBROW = { question: 'Claude is asking', permission: 'Permission', plan: 'Plan' };

/** The oldest pending card for this run, or nothing. `onAnswer(card, answer)` sends it; `busy` while one is in flight. */
export default function PhoneCards({ pending, busy, note, onAnswer }) {
  const card = Array.isArray(pending) ? pending[0] : null;
  if (!card) return null;
  const Body = card.kind === 'question' ? QuestionCard : card.kind === 'plan' ? PlanCard : PermissionCard;
  return (
    <div className="ask-card phone-card" role="group" aria-label={EYEBROW[card.kind]}>
      <div className="ask-head">
        <span className="ask-eyebrow">{EYEBROW[card.kind]}{card.kind === 'permission' && card.tool ? `: ${card.displayName || card.tool}` : ''}</span>
        {pending.length > 1 && <span className="phone-count">1 of {pending.length}</span>}
      </div>
      {/* Keyed by the request: a new card never inherits the last one's picks or note. */}
      <Body key={card.requestId} card={card} busy={busy} onAnswer={(a) => onAnswer(card, a)} />
      {note && <p className="ask-note" role="alert">{note}</p>}
    </div>
  );
}
