import { useState, useEffect } from 'react';

export default function QuitOverlay() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!window.electronAPI) return;
    const removePrompt = window.electronAPI.onQuitPrompt(() => setVisible(true));
    const removeCancel = window.electronAPI.onQuitCancel(() => setVisible(false));
    return () => {
      removePrompt();
      removeCancel();
    };
  }, []);

  if (!visible) return null;

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'rgba(0, 0, 0, 0.6)',
        backdropFilter: 'blur(4px)',
      }}
    >
      <div
        style={{
          color: '#E6EDF3',
          fontSize: 18,
          fontWeight: 600,
          letterSpacing: '0.05em',
          textAlign: 'center',
          padding: '16px 32px',
          borderRadius: 12,
          backgroundColor: 'rgba(22, 27, 34, 0.9)',
          border: '1px solid rgba(255, 255, 255, 0.1)',
        }}
      >
        Hold Cmd+Q to quit
      </div>
    </div>
  );
}
