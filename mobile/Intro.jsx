// Pre-pair explainer, reachable from Pairing.jsx with a "What is Dobius+?"
// link. Exists primarily so an Apple reviewer who does not have a Mac
// running Dobius+ can see what the app does: the pairing form alone is
// opaque. Three cards describe the three main workflows; a fourth tells
// the reviewer how to request a reviewer-tailored Mac build if they want
// to exercise the full app. Pure JS, no network calls.

export default function Intro({ onBack }) {
  const cards = [
    {
      title: 'Pair with your Mac',
      body: 'Install Dobius+ on your Mac from dobiusplus.app, open Settings › Mobile Access, and scan the QR code. Your phone connects to your own Mac over Tailscale, so terminals stay on your machine.',
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
      title: 'For App Store reviewers',
      body: 'This app pairs with a copy of Dobius+ running on the user’s own Mac. If you would like temporary access to a demo Mac for review, email reviewer@dobiusplus.app and we will provision one for your Apple ID.',
    },
  ];
  return (
    <div className="screen" style={{ padding: '16px 20px 32px', overflowY: 'auto' }}>
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
