// iOS draws the keyboard over the page without resizing it, so the bar stays at
// the bottom of a page taller than what shows, with empty space above the keys.
// The visual viewport knows what is really visible; this sizes the chat to it.

const MIN_KEYBOARD_PX = 120; // a browser toolbar sliding is not a keyboard

export function keyboardFit(innerHeight, viewportHeight, scale = 1) {
  const open = scale <= 1.01 && innerHeight - viewportHeight >= MIN_KEYBOARD_PX;
  return { open, height: open ? Math.round(viewportHeight) : null };
}

export function attachKeyboardFit(win = window) {
  const vv = win.visualViewport;
  if (!vv) return () => {};
  const root = win.document.documentElement;
  const apply = () => {
    const { open, height } = keyboardFit(win.innerHeight, vv.height, vv.scale);
    root.classList.toggle('keyboard-open', open);
    if (open) {
      root.style.setProperty('--app-height', `${height}px`);
      // iOS scrolled the page to reveal the input. Chat fits now, so scroll back;
      // other screens (pairing) are not fitted and need that scroll.
      if (win.scrollY && win.document.querySelector('.chat-view')) win.scrollTo(0, 0);
    } else {
      root.style.removeProperty('--app-height');
    }
  };
  vv.addEventListener('resize', apply);
  vv.addEventListener('scroll', apply);
  apply();
  return () => {
    vv.removeEventListener('resize', apply);
    vv.removeEventListener('scroll', apply);
  };
}
