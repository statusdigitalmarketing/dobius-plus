// Pre-pair explainer, reachable from Pairing.jsx with a "What is Dobius+?"
// link. Exists primarily so an Apple reviewer who does not have a Mac
// running Dobius+ can see what the app does: the pairing form alone is
// opaque. Three cards describe the three main workflows; a fourth gives
// the demo credentials (mobile/demo.js) that run the full app on sample
// data with no Mac. Pure JS, no network calls.

export default function Intro({ onBack }) {
  const cards = [
    {
      title: 'Pair with your Mac',
      body: 'Install Dobius+ on your Mac from dobepros.com/dobius-plus, open Settings › Mobile Access, and enter the Mac address and pairing code shown there. Your phone connects to your own Mac over Tailscale, so terminals stay on your machine.',
    },
    {
      title: 'Your terminals, anywhere',
      body: 'Every Claude Code session running on your Mac shows up as a card. Tap one to open the live terminal, scroll back through output, send keystrokes, or type a new prompt.',
    },
    {
      title: 'Hold the mic to talk',
      body: 'Hold the voice button to speak a command. The Mac transcribes locally with whisper.cpp, routes it to the right Claude session, and reads the reply back.',
    },
    {
      title: 'Try it without a Mac',
      body: 'Enter the Mac address demo.dobius and the pairing code 123456 to explore the full app with sample sessions. Nothing leaves your phone. Tap “Pair your Mac” on the session board to leave the demo.',
    },
  ];
  return (
    <div className="screen" style={{ padding: 'calc(env(safe-area-inset-top) + 16px) 20px 32px', overflowY: 'auto' }}>
      <div style={{ maxWidth: 540, margin: '0 auto' }}>
        <button
          onClick={onBack}
          style={{ background: 'none', border: 'none', color: '#D97757', fontSize: 15, padding: '8px 0', cursor: 'pointer' }}
        >
          &lsaquo; Back
        </button>
        <h1 style={{ fontSize: 32, fontWeight: 600, letterSpacing: '-0.5px', margin: '12px 0 24px' }}>
          What is Dobius+?
        </h1>
        {cards.map((c) => (
          <div
            key={c.title}
            style={{
              background: 'rgba(255,255,255,0.04)',
              border: '1px solid rgba(255,255,255,0.08)',
              borderRadius: 12,
              padding: 16,
              marginBottom: 12,
            }}
          >
            <h2 style={{ fontSize: 17, fontWeight: 600, margin: '0 0 6px' }}>{c.title}</h2>
            <p style={{ color: '#B4B2AE', fontSize: 14, lineHeight: 1.5, margin: 0 }}>{c.body}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
