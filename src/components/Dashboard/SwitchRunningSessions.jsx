import { useState, useEffect, useRef, useCallback } from 'react';

/**
 * Move every RUNNING Claude session to another account.
 *
 * The problem this solves: an account's usage runs out mid-work. Switching the
 * active account only ever affected NEW terminals, so the sessions actually
 * burning the quota kept burning it, invisibly, and the only way to find them
 * was to guess which tab was pinned where.
 *
 * It works by re-logging the config DIRECTORIES those sessions use, because a
 * running claude reads its credential from the directory rather than holding
 * it. That moves every session on a directory at once with nothing restarted.
 *
 * The honest cost, shown in the UI rather than buried: the CLI has no
 * force-relogin, so the logout comes first, and between it and the browser
 * finishing, those sessions have no credential and their calls fail. It also
 * overwrites whatever account that directory held.
 */
const AMBER = '#fbbf24';
const RED = '#f87171';
const shortName = (p) => String(p).split('/').filter(Boolean).pop() || String(p);

export default function SwitchRunningSessions({ accounts, identities }) {
  const [plan, setPlan] = useState(null);
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(null);
  const [result, setResult] = useState(null);
  const [interrupted, setInterrupted] = useState([]);
  // The login prints the authorization URL when it cannot open a browser.
  // Replacing it with the next progress line would hide the only way to finish
  // the flow and restore the credential (reviewer MEDIUM).
  const [authOutput, setAuthOutput] = useState('');
  const mounted = useRef(true);
  // Guards a slower preview for an older target from overwriting the current
  // one (reviewer MEDIUM).
  const planSeq = useRef(0);

  const loadInterrupted = useCallback(async () => {
    const list = await window.electronAPI?.accountsSwitchInterrupted?.();
    if (mounted.current) setInterrupted(Array.isArray(list) ? list : []);
  }, []);

  // Distinct addresses we could switch TO, from the saved rows plus Default.
  const targets = (() => {
    const seen = new Map();
    const add = (email) => { if (email && !seen.has(email.toLowerCase())) seen.set(email.toLowerCase(), email); };
    add(identities?.default?.email);
    accounts.forEach((a, i) => {
      if (a.type !== 'claude') return;
      const row = identities?.accounts?.[i];
      if (row && row.id === a.id) add(row.email);
    });
    return [...seen.values()];
  })();

  const refresh = useCallback(async (email) => {
    if (!email || !window.electronAPI?.accountsSwitchPlan) return;
    const seq = ++planSeq.current;
    const res = await window.electronAPI.accountsSwitchPlan(email);
    if (!mounted.current || seq !== planSeq.current) return; // superseded
    if (res?.ok) setPlan(res.plan);
  }, []);

  useEffect(() => {
    mounted.current = true;
    loadInterrupted();
    // A job lives in main and outlives this panel, so a panel reopened mid-flow
    // must adopt it rather than showing no Cancel, and a panel reopened AFTER
    // it ended must still be able to show the outcome (reviewer HIGH).
    window.electronAPI?.accountsSwitchRunning?.().then((r) => {
      if (!mounted.current || !r) return;
      if (r.running) {
        setBusy(true);
        if (r.target) setTarget(r.target);
        // Replay what the login already printed, or its one authorization URL
        // is gone for good (reviewer HIGH).
        if (r.output) setAuthOutput(r.output);
        return;
      }
      if (r.lastResult) setResult(r.lastResult);
    });
    const off = window.electronAPI?.onAccountsSwitchProgress?.((ev) => {
      if (!mounted.current) return;
      if (ev.phase === 'output') { setAuthOutput((prev) => (prev + ev.chunk).slice(-1500)); return; }
      // The terminal event carries the result, so any mounted panel can finish
      // the flow even though the invoke resolved into an unmounted one.
      if (ev.phase === 'finished') {
        setBusy(false); setProgress(null); setResult(ev.result);
        // Drop the preview before re-requesting it. Another window's job can
        // have moved the very sessions this plan counted, and leaving it up
        // kept the button armed with a stale count during the refresh: it read
        // "Move 1" while the run it would start covered 21 (reviewer HIGH).
        setPlan(null);
        loadInterrupted();
        // Re-preview OUR OWN selection. Refreshing for the finished job's
        // target instead left a second window showing that target's plan under
        // its own unchanged selector, so its button sat on "Checking..."
        // forever with no way to re-arm it (reviewer MEDIUM, two passes).
        setTarget((t) => { if (t) refresh(t); return t; });
        return;
      }
      // A job started in ANOTHER window still owns the single browser flow, so
      // every panel has to show it as running. Without this the second window
      // kept an armed Move button, and hid both the authorization URL and
      // Cancel behind `busy` while the credential was signed out (reviewer
      // HIGH, two passes).
      setBusy(true);
      setProgress(ev);
    });
    return () => { mounted.current = false; off?.(); };
  }, [loadInterrupted, refresh]);

  // Default the target once identities load, and correct it if the account it
  // names stops being one of them. A removed address left `target` pointing at
  // it while the selector, having no such option, DISPLAYED a different
  // account: the armed button then read one destination and would have signed
  // sessions into the other (reviewer HIGH).
  useEffect(() => {
    // No accounts left to switch TO: the selector renders blank, so the plan
    // must go with it. Returning early here left the button armed on a
    // destination that was no longer displayed anywhere (reviewer HIGH).
    if (!targets.length) {
      if (target) { setPlan(null); setTarget(''); }
      return;
    }
    if (!target) { setTarget(targets[0]); return; }
    if (!targets.includes(target)) { setPlan(null); setTarget(targets[0]); }
  }, [targets, target]);

  useEffect(() => { if (target) refresh(target); }, [target, refresh]);

  const run = async () => {
    setBusy(true); setResult(null); setProgress(null); setAuthOutput('');
    const cliPath = accounts.find((a) => a.type === 'claude' && a.cliPath)?.cliPath || null;
    // Send the exact credentials the list showed. Execution re-plans, because
    // sessions come and go, but it may only act on these.
    const approved = (plan?.groups || []).filter((g) => g.action === 'switch').map((g) => g.key);
    const res = await window.electronAPI.accountsSwitchRun(target, cliPath, approved);
    if (!mounted.current) return;
    // A rejection because ANOTHER window already owns the job does not mean
    // nothing is running. Clearing busy on it hid that job's authorization URL
    // and its Cancel for the whole signed-out interval (reviewer HIGH).
    if (res?.error && /already running/i.test(res.error)) return;
    setBusy(false); setResult((prev) => prev || res); setProgress(null);
    // Re-preview whatever is selected NOW, not the target captured when this
    // run started. Deleting an account mid-login moves the selector, and
    // refreshing for the captured value left the plan describing one account
    // under a selector showing another, with the button stuck on "Checking..."
    // (reviewer MEDIUM, same stale-closure shape as the finished handler).
    setTarget((t) => { if (t) refresh(t); return t; });
    loadInterrupted();
  };

  const stranded = interrupted.filter((i) => !i.recovered);
  // A login in flight owns the browser and holds a credential signed out, so
  // its URL and its Cancel must stay on screen even when there is no plan and
  // nothing stranded yet. Deleting the last account mid-login emptied the
  // targets, cleared the plan, and took the only way to finish or abort the
  // flow with it (reviewer HIGH).
  if (!plan && stranded.length === 0 && !busy) return null;

  // A plan previewed for a DIFFERENT address must never arm the button: picking
  // another account while a preview was in flight left "Move 1" on screen and
  // then logged out every group of the new target, 21 sessions (reviewer HIGH).
  const planFresh = !!plan && plan.target === target;
  const skipping = (plan?.groups || []).filter((g) => g.action === 'skip');
  const toSwitch = (plan?.groups || []).filter((g) => g.action === 'switch');
  const sessionsToMove = planFresh ? (plan.willSwitch || 0) : 0;

  const box = {
    backgroundColor: 'var(--surface)', border: '1px solid var(--border)',
    borderRadius: 8, padding: '10px 12px', marginBottom: 10,
  };
  // A disabled control has to LOOK disabled. Rendering "Nothing to move" in
  // full accent left the one destructive button in this panel looking armed.
  const btn = (primary, disabled = false) => ({
    padding: '5px 12px', borderRadius: 6, fontSize: 12,
    cursor: disabled ? 'default' : 'pointer',
    backgroundColor: primary && !disabled ? 'var(--accent)' : 'transparent',
    color: primary && !disabled ? '#fff' : 'var(--dim)',
    border: primary && !disabled ? 'none' : '1px solid var(--border)',
    opacity: disabled ? 0.55 : 1,
  });
  const warn = {
    backgroundColor: 'rgba(248,113,113,0.12)', border: '1px solid rgba(248,113,113,0.35)',
  };

  return (
    <div style={box}>
      <div className="text-sm font-medium mb-1" style={{ color: 'var(--fg)' }}>
        Running sessions
      </div>

      {stranded.map((i) => (
        <div key={i.key} className="text-xs mb-2 px-2 py-1.5 rounded" style={warn}>
          A previous switch was interrupted on{' '}
          <span style={{ fontFamily: 'monospace' }}>{shortName(i.configDir)}</span>
          {i.unreadable ? ' ' : '. '}
          {i.unreadable
            ? <> could not be READ, so a profile may be signed out with no way to tell. Check its permissions.</>
            : i.loginState === 'in'
            ? <> It is signed in as <span style={{ fontFamily: 'monospace' }}>{i.currentEmail || 'an unreadable address'}</span>, <strong>not {i.target}</strong>, so it did not reach the account you asked for.</>
              : <> It is <strong>still signed out</strong>, so sessions on it have no login. Run the switch again to finish it.</>}
        </div>
      ))}

      {busy && (
        <div className="mb-2">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-xs" style={{ color: 'var(--dim)', fontFamily: 'monospace' }}>
              {progress?.phase === 'logout' ? `signing out ${shortName(progress.configDir)}…`
                : progress?.phase === 'awaiting-browser' ? 'waiting for you to authorize in the browser…'
                : progress?.phase === 'done-one' ? `${shortName(progress.configDir)}: ${progress.state}`
                : 'switching…'}
            </span>
            <button style={btn(false)} onClick={() => window.electronAPI.accountsSwitchCancel()}>Cancel</button>
          </div>
          {authOutput && (
            <pre className="text-xs" style={{
              backgroundColor: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6,
              padding: '6px 8px', fontFamily: 'monospace', fontSize: 11, whiteSpace: 'pre-wrap',
              wordBreak: 'break-all', margin: 0, maxHeight: 120, overflowY: 'auto',
            }}>{authOutput}</pre>
          )}
        </div>
      )}

      {plan && (
        <>
          {plan.discoveryFailed && (
            <div className="text-xs mb-2 px-2 py-1.5 rounded" style={warn}>
              Could not list running processes, so this is <strong>not a complete picture</strong>.
              Sessions missing from it will stay on their current account.
            </div>
          )}

          <div className="text-xs mb-2" style={{ color: 'var(--dim)' }}>
            {plan.totalSessions} Claude {plan.totalSessions === 1 ? 'session is' : 'sessions are'} running.
            {skipping.length > 0 && <> {skipping.reduce((n, g) => n + g.sessions, 0)} already on this account.</>}
            {plan.unresolved.length > 0 && (
              <span style={{ color: AMBER }}>
                {' '}{plan.unresolved.length} could not be read, so they may not be covered.
              </span>
            )}
          </div>

          <div className="flex items-center gap-2 flex-wrap mb-2">
            <span className="text-xs" style={{ color: 'var(--dim)' }}>Move them to</span>
            <select
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              disabled={busy}
              style={{
                backgroundColor: 'var(--bg)', color: 'var(--fg)', border: '1px solid var(--border)',
                borderRadius: 6, padding: '4px 8px', fontSize: 12, fontFamily: 'monospace',
              }}
            >
              {targets.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
            <button
              style={btn(true, busy || !planFresh || sessionsToMove === 0)}
              disabled={busy || !planFresh || sessionsToMove === 0}
              onClick={run}
            >
              {busy ? 'Switching…'
                : !planFresh ? 'Checking…'
                : sessionsToMove === 0 ? 'Nothing to move'
                : `Move ${sessionsToMove}`}
            </button>
          </div>

          {plan.unverifiable > 0 && (
            <div className="text-xs mb-1" style={{ color: AMBER }}>
              {plan.unverifiable} session{plan.unverifiable === 1 ? '' : 's'} sit on a profile whose
              login record is shared with another profile or disagrees with itself, so there is no
              way to tell which account {plan.unverifiable === 1 ? 'it is' : 'they are'} on. Moving
              {plan.unverifiable === 1 ? ' it' : ' them'} would sign that profile out on every run,
              even once it is already correct, so it is left out of the button above.
            </div>
          )}

          {planFresh && toSwitch.length > 0 && !busy && (
            <>
              {/* Name every profile before signing any of them out.
                * A binding is read from `ps`, whose output is a flat string
                * with no recoverable token boundaries, so an exotic path or
                * environment can still be misread. Listing what is about to be
                * signed out is what makes such a misread VISIBLE while it is
                * still harmless, instead of a credential quietly disappearing.
                */}
              <div className="text-xs mb-1" style={{ color: 'var(--dim)' }}>
                Signs out {toSwitch.length === 1 ? 'this profile' : 'these profiles'}, then signs
                {toSwitch.length === 1 ? ' it' : ' them'} back in as {target}:
              </div>
              <ul className="text-xs mb-1" style={{ color: 'var(--fg)', listStyle: 'none', margin: 0, padding: 0 }}>
                {toSwitch.map((g) => (
                  <li key={g.key} style={{ fontFamily: 'monospace', paddingLeft: 8 }}>
                    {g.envUnset ? 'default' : shortName(g.configDir)}
                    <span style={{ color: 'var(--dim)' }}>
                      {' '}({g.sessions} session{g.sessions === 1 ? '' : 's'}
                      {g.currentEmail ? `, now ${g.currentEmail}` : ', account unreadable'})
                    </span>
                  </li>
                ))}
              </ul>
              <div className="text-xs" style={{ color: AMBER }}>
                These sessions will have no login from the moment each profile signs out until you
                finish in the browser, so calls will fail in that gap. This also replaces whichever
                account each profile currently holds.
              </div>
            </>
          )}

          {result && (
            <div className="text-xs mt-1" style={{ color: result.ok ? 'var(--dim)' : RED }}>
              {result.error
                ? result.error
                : (result.results || []).map((r) => (
                    <div key={r.key}>
                      {shortName(r.configDir)}: {
                        r.state === 'switched' ? `moved ${r.sessions} session${r.sessions === 1 ? '' : 's'}`
                        : r.state === 'wrong-account' ? `landed on ${r.landedEmail}, not ${result.target}`
                        : r.state === 'logged-out' || r.state === 'signed-out' ? 'left signed out, run it again to finish'
                        : r.state
                      }
                    </div>
                  ))}
              {(result.notSwitched || []).length > 0 && (() => {
                const n = result.notSwitched.reduce((t, g) => t + g.sessions, 0);
                return (
                  <div style={{ color: AMBER }}>
                    {result.notSwitched.length} {result.notSwitched.length === 1 ? 'profile' : 'profiles'} did
                    not move, so {n} session{n === 1 ? ' is' : 's are'} still on the old account.
                  </div>
                );
              })()}
              {(result.appeared || []).length > 0 && (() => {
                const n = result.appeared.reduce((t, g) => t + g.sessions, 0);
                return (
                  <div style={{ color: AMBER }}>
                    {n} session{n === 1 ? '' : 's'} started on{' '}
                    {result.appeared.map((g) => (g.envUnset ? 'default' : shortName(g.configDir))).join(', ')}{' '}
                    after you reviewed this, so {n === 1 ? 'it was' : 'they were'} left alone. Run it
                    again to include {n === 1 ? 'it' : 'them'}.
                  </div>
                );
              })()}
              {result.remaining > 0 && <div>{result.remaining} still on another account.</div>}
              {result.discoveryFailed && (
                <div style={{ color: AMBER }}>
                  Process discovery failed afterwards, so this count may be low.
                </div>
              )}
              {result.unresolved > 0 && (
                <div style={{ color: AMBER }}>
                  {result.unresolved} session{result.unresolved === 1 ? '' : 's'} could not be identified, so this is not full coverage.
                </div>
              )}
              {result.unverifiable > 0 && (
                <div style={{ color: AMBER }}>
                  {result.unverifiable} session{result.unverifiable === 1 ? '' : 's'} could not be verified either way.
                </div>
              )}
              {result.note && <div>{result.note}</div>}
            </div>
          )}
        </>
      )}
    </div>
  );
}
