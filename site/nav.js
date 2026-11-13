const links = [...document.querySelectorAll('.secnav a[href^="#"]')];
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
