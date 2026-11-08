import { useState, useEffect } from 'react';

// What a fresh Mac needs before Add Google Account can work (Justin, 2026-11-07): the gws program (it needs Node.js)
// and a Google OAuth client file. Each missing piece gets its own one-click fix, so nobody has to open a terminal.
// When everything is in place this collapses to one line.

const tilde = (p) => String(p || '').replace(/^\/Users\/[^/]+/, '~');

function Dot({ ok, busy }) {
  return (
    <span
      aria-hidden="true"
      style={{ width: 9, height: 9, borderRadius: '50%', flexShrink: 0, marginTop: 4, backgroundColor: busy ? '#d29922' : ok ? '#3fb950' : '#f87171' }}
    />
  );
}

export default function GwsSetup({ status, onRefresh, onClientChanged, btn }) {
  const [busy, setBusy] = useState(''); // 'check' | 'install' | 'locate' | 'client'
  const [msg, setMsg] = useState(null); // { text, isError, output }
  const [open, setOpen] = useState(false);
  const api = window.electronAPI;

  // An install started before this panel was opened (or before a page switch) is still running in main: show it and
  // look again every 2s until it ends, so the result lands here either way.
  const installingElsewhere = !!status?.installing && busy !== 'install';
  useEffect(() => {
    if (!installingElsewhere) return undefined;
    let inFlight = false; // one poll at a time: a slow gws never stacks requests
    const t = setInterval(() => {
      if (inFlight) return;
      inFlight = true;
      Promise.resolve(onRefresh()).finally(() => { inFlight = false; });
    }, 2000);
    return () => clearInterval(t);
  }, [installingElsewhere]); // eslint-disable-line react-hooks/exhaustive-deps -- onRefresh is recreated each render

  const run = async (kind, fn, okText) => {
    if (busy) return;
    setBusy(kind);
    setMsg(null);
    try {
      const res = await fn();
      if (res?.canceled) return;
      if (res && res.ok === false) setMsg({ text: res.error || 'That did not work.', isError: true, output: res.output, needsNode: res.needsNode });
      else if (okText) setMsg({ text: typeof okText === 'function' ? okText(res) : okText });
      // A new client file can mean a new Cloud project: each account is asked again whether it may use it for quota.
      if (kind === 'client' && res?.ok) onClientChanged?.();
    } catch {
      setMsg({ text: 'That did not work.', isError: true });
    } finally {
      await onRefresh(kind === 'check' ? { force: true } : undefined);
      setBusy('');
    }
  };


  if (!status) {
    return <p className="text-xs mb-3" style={{ color: 'var(--dim)' }}>Checking this Mac for gws…</p>;
  }

  // Node is a problem when it is too old (gws's installer needs a new one too), or missing for an npm gws.
  const nodeMissing = !!status.nodeTooOld || (!!status.gws && status.needsNode && !status.node);
  const gwsOk = !!status.gws && !status.halfInstalled && !nodeMissing;
  const clientOk = !!status.client;

  if (status.ready && !open) {
    return (
      <div className="text-xs mb-3 flex items-center gap-2" style={{ color: 'var(--dim)' }}>
        <Dot ok />
        <span className="truncate">
          Ready: gws at {tilde(status.gws)}, OAuth client {status.client.kind === 'gws' ? 'from gws setup' : status.client.kind === 'env' ? 'from the environment' : status.client.project ? `from ${status.client.project}` : 'in place'}.
        </span>
        <button onClick={() => setOpen(true)} style={{ background: 'none', border: 'none', color: 'var(--dim)', cursor: 'pointer', textDecoration: 'underline', fontSize: 11, flexShrink: 0 }}>
          Setup
        </button>
      </div>
    );
  }

  return (
    <div className="mb-4 px-3 py-3 rounded-lg" style={{ backgroundColor: 'var(--surface)', border: `1px solid ${status.ready ? 'var(--border)' : 'rgba(210,153,34,0.45)'}` }}>
      <div className="flex items-center justify-between mb-2">
        <div className="text-sm font-medium" style={{ color: 'var(--fg)' }}>
          {status.ready ? 'Setup' : 'Two things this Mac needs first'}
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => run('check', () => null, null)}
            disabled={!!busy}
            style={{ background: 'none', border: 'none', color: 'var(--dim)', cursor: 'pointer', fontSize: 11 }}
          >
            {busy === 'check' ? 'Checking…' : 'Check again'}
          </button>
          {status.ready && (
            <button onClick={() => setOpen(false)} style={{ background: 'none', border: 'none', color: 'var(--dim)', cursor: 'pointer', fontSize: 11 }}>Hide</button>
          )}
        </div>
      </div>

      {/* 1. gws (and Node.js, which runs it) */}
      <div className="flex gap-2.5 py-2" style={{ borderTop: '1px solid var(--border)' }}>
        <Dot ok={gwsOk} busy={busy === 'install'} />
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium" style={{ color: 'var(--fg)' }}>1. The gws program</div>
          <div className="text-xs mt-0.5" style={{ color: 'var(--dim)' }}>
            {gwsOk && <>Installed at <code style={{ fontFamily: 'monospace' }}>{tilde(status.gws)}</code>.</>}
            {!gwsOk && status.windows && <>Dobius talks to Google through gws, Google's Workspace command line, and it is not installed yet. Install Node.js (the LTS download), then in PowerShell run <code style={{ fontFamily: 'monospace' }}>npm i -g @googleworkspace/cli</code> and press Check again.</>}
            {!gwsOk && !status.windows && !status.npm && !status.gws && <>gws runs on Node.js, which this Mac does not have yet. Install Node.js (the LTS download), then press Check again.</>}
            {!gwsOk && status.npm && !status.gws && !nodeMissing && <>Dobius talks to Google through gws, Google's Workspace command line. It is not installed yet. Install takes about a minute.</>}
            {nodeMissing && status.nodeTooOld && <>The Node.js on this Mac is version {status.nodeMajor}, and gws needs {status.minNode} or newer. Install the current Node.js LTS, then press Check again.</>}
            {status.halfInstalled && !nodeMissing && <>gws at <code style={{ fontFamily: 'monospace' }}>{tilde(status.gws)}</code> did not finish installing (its program never downloaded). Press Install gws to finish it.</>}
            {nodeMissing && !status.nodeTooOld && <>gws is at <code style={{ fontFamily: 'monospace' }}>{tilde(status.gws)}</code>, but Node.js, which runs it, was not found. Install Node.js, then press Check again.</>}
            {(busy === 'install' || installingElsewhere) && <> Installing with npm, this can take a minute…</>}
          </div>
          {!gwsOk && status.windows && (
            <div className="flex flex-wrap gap-2 mt-2">
              <button style={btn('primary')} onClick={() => api?.gwsSetupOpenNode?.()}>Get Node.js</button>
            </div>
          )}
          {!gwsOk && !status.windows && (
            <div className="flex flex-wrap gap-2 mt-2">
              {!status.npm || nodeMissing ? (
                <button style={btn('primary')} onClick={() => api?.gwsSetupOpenNode?.()}>Get Node.js</button>
              ) : (
                <button style={btn('primary', { opacity: busy || installingElsewhere ? 0.6 : 1 })} disabled={!!busy || installingElsewhere} onClick={() => run('install', () => api?.gwsSetupInstall?.(), (r) => `gws installed at ${tilde(r?.gws)}.`)}>
                  {busy === 'install' || installingElsewhere ? 'Installing…' : 'Install gws'}
                </button>
              )}
              <button style={btn('default', { opacity: busy ? 0.6 : 1 })} disabled={!!busy} onClick={() => run('locate', () => api?.gwsSetupLocate?.(), (r) => `Using gws at ${tilde(r?.gws)}.`)}>
                Already installed? Locate gws…
              </button>
            </div>
          )}
        </div>
      </div>

      {gwsOk && !status.windows && (
        <div className="pb-2 -mt-1" style={{ paddingLeft: 19 }}>
          <button
            onClick={() => run('locate', () => api?.gwsSetupLocate?.(), (r) => `Using gws at ${tilde(r?.gws)}.`)}
            disabled={!!busy}
            style={{ background: 'none', border: 'none', padding: 0, color: 'var(--dim)', cursor: 'pointer', fontSize: 11, textDecoration: 'underline' }}
          >
            Use a different gws…
          </button>
        </div>
      )}

      {/* 2. The OAuth client file */}
      <div className="flex gap-2.5 py-2" style={{ borderTop: '1px solid var(--border)' }}>
        <Dot ok={clientOk} busy={busy === 'client'} />
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium" style={{ color: 'var(--fg)' }}>2. Your Google OAuth client file</div>
          <div className="text-xs mt-0.5" style={{ color: 'var(--dim)' }}>
            {clientOk && status.client.kind === 'gws' && <>gws already has a client from its own setup.</>}
            {clientOk && status.client.kind === 'env' && <>Given to gws by the GOOGLE_WORKSPACE_CLI_CLIENT_ID environment variable.</>}
            {clientOk && status.client.kind !== 'gws' && status.client.kind !== 'env' && <>In place{status.client.project ? ` (Google Cloud project ${status.client.project})` : ''}, at <code style={{ fontFamily: 'monospace' }}>{tilde(status.client.path)}</code>.</>}
            {!clientOk && status.envClientEmpty && <>GOOGLE_WORKSPACE_CLI_CLIENT_ID and _SECRET are set but empty, and gws uses them over any file. Unset them (or fill them in), then restart Dobius. </>}
            {!clientOk && status.incompleteClient && <>The client file in place is missing fields gws needs; download it again from Google Cloud. </>}
            {!clientOk && status.webClient && <>The file at <code style={{ fontFamily: 'monospace' }}>{tilde(status.webClientPath)}</code> is a Web application client, and gws needs a Desktop app client. </>}
            {!clientOk && <>Google only lets an app sign in with a client file from a Google Cloud project, named like <code style={{ fontFamily: 'monospace' }}>client_secret_….json</code>. Get it from whoever runs your team's Google Cloud project, or make one under APIs &amp; Services, Credentials, Create OAuth client, Desktop app.</>}
          </div>
          {!clientOk && status.clientCandidates?.length > 0 && (
            <div className="mt-2 space-y-1.5">
              <div className="text-xs" style={{ color: 'var(--fg)' }}>Found on this Mac:</div>
              {status.clientCandidates.map((c) => (
                <div key={c.path} className="flex items-center justify-between gap-2 text-xs">
                  <span className="truncate" style={{ color: 'var(--dim)' }}>
                    <code style={{ fontFamily: 'monospace' }}>{tilde(c.path)}</code>{c.project ? ` · ${c.project}` : ''}
                  </span>
                  <button style={btn('primary', { flexShrink: 0, opacity: busy ? 0.6 : 1 })} disabled={!!busy} onClick={() => run('client', () => api?.gwsSetupUseClient?.(c.path), 'OAuth client file in place.')}>
                    Use this one
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="flex flex-wrap gap-2 mt-2">
            <button style={btn(clientOk || status.clientCandidates?.length ? 'default' : 'primary', { opacity: busy ? 0.6 : 1 })} disabled={!!busy} onClick={() => run('client', () => api?.gwsSetupChooseClient?.(), 'OAuth client file in place.')}>
              {clientOk ? 'Replace client file…' : 'Choose client_secret.json…'}
            </button>
          </div>
        </div>
      </div>

      {!busy && !installingElsewhere && status.lastInstall && !status.lastInstall.ok && !gwsOk && (
        <div className="text-xs mt-2" style={{ color: '#f87171' }}>
          The last install did not finish: {status.lastInstall.error || 'npm failed.'}
          {status.lastInstall.output && (
            <pre className="mt-1.5 p-2 rounded overflow-auto" style={{ maxHeight: 160, fontFamily: 'monospace', fontSize: 11, color: 'var(--dim)', backgroundColor: 'var(--bg)', border: '1px solid var(--border)', whiteSpace: 'pre-wrap' }}>
              {status.lastInstall.output}
            </pre>
          )}
        </div>
      )}

      {msg && (
        <div className="text-xs mt-2" style={{ color: msg.isError ? '#f87171' : '#3fb950' }}>
          {msg.text}
          {msg.output && (
            <pre className="mt-1.5 p-2 rounded overflow-auto" style={{ maxHeight: 160, fontFamily: 'monospace', fontSize: 11, color: 'var(--dim)', backgroundColor: 'var(--bg)', border: '1px solid var(--border)', whiteSpace: 'pre-wrap' }}>
              {msg.output}
            </pre>
          )}
        </div>
      )}

      <p className="text-xs mt-2 pt-2" style={{ color: 'var(--dim)', borderTop: '1px solid var(--border)' }}>
        Then press Add Google Account below. Accounts are added here in Dobius, there is no need to run <code style={{ fontFamily: 'monospace' }}>gws auth login</code>. If the Google Cloud project is in Testing mode, only the test users listed on its consent screen can sign in, and each sign-in lasts 7 days before it needs Reconnect.
      </p>
    </div>
  );
}
