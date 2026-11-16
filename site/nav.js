const links = [...document.querySelectorAll('.toc a[href^="#"]')];
const targets = new Map();
for (const a of links) {
  const el = document.getElementById(a.hash.slice(1));
  if (el) targets.set(el, a);
}
if (targets.size && 'IntersectionObserver' in window) {
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      for (const a of links) a.removeAttribute('aria-current');
      targets.get(e.target).setAttribute('aria-current', 'true');
    }
  }, { rootMargin: '-25% 0px -65% 0px' });
  for (const el of targets.keys()) io.observe(el);
}

const themeBtn = document.getElementById('theme-btn');
if (themeBtn) {
  const modes = ['auto', 'light', 'dark'];
  const names = { auto: 'auto', light: 'light', dark: 'dark' };
  const root = document.documentElement;
  const paint = (mode) => {
    themeBtn.replaceChildren(Object.assign(document.createElement('span'), { className: 'tb-k', textContent: 'Theme: ' }), names[mode]);
    themeBtn.setAttribute('aria-label', `Colour theme: ${mode === 'auto' ? 'follows the system' : mode}. Change`);
  };
  let mode = root.getAttribute('data-theme') || 'auto';
  paint(mode);
  themeBtn.hidden = false;
  themeBtn.addEventListener('click', () => {
    mode = modes[(modes.indexOf(mode) + 1) % modes.length];
    if (mode === 'auto') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', mode);
    try {
      if (mode === 'auto') localStorage.removeItem('theme');
      else localStorage.setItem('theme', mode);
    } catch {}
    paint(mode);
  });
}
