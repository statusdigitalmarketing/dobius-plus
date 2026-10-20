// Every "needs you" dot (tab bar, grid cell headers, Sessions list) pulses with
// the CSS animation dobius-status-pulse. Each one starts when its element
// mounts, so several red dots blinked out of step, which reads as noise. Pin
// every such animation to the document timeline's origin as it starts: they
// then share one phase no matter when they appeared.

const PULSE = 'dobius-status-pulse';

export function installPulseSync(doc = document) {
  const onStart = (e) => {
    if (e.animationName !== PULSE || !e.target?.getAnimations) return;
    for (const a of e.target.getAnimations()) {
      if (a.animationName === PULSE && a.startTime !== 0) a.startTime = 0;
    }
  };
  doc.addEventListener('animationstart', onStart, true);
  return () => doc.removeEventListener('animationstart', onStart, true);
}
