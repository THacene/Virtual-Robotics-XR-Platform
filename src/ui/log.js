export function log(msg, cls = 'info') {
  const el = document.getElementById('termLog');
  if (!el) return;
  const s = document.createElement('span');
  s.className = 'tl ' + cls;
  s.textContent = msg;
  el.appendChild(s);
  el.scrollTop = el.scrollHeight;
}