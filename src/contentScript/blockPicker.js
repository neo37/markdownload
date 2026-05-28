(function () {
  if (window.__mdPickerActive) return;
  window.__mdPickerActive = true;

  let _last = null;

  const OUTLINE = '3px solid #4A90E2';
  const OUTLINE_HOVER = '2px dashed #4A90E2';

  // Tooltip
  const tip = document.createElement('div');
  Object.assign(tip.style, {
    position: 'fixed', bottom: '16px', left: '50%', transform: 'translateX(-50%)',
    background: '#4A90E2', color: '#fff', padding: '8px 18px', borderRadius: '20px',
    fontSize: '13px', zIndex: '2147483647', pointerEvents: 'none',
    boxShadow: '0 4px 12px rgba(0,0,0,0.3)', fontFamily: 'sans-serif',
    whiteSpace: 'nowrap'
  });
  tip.textContent = '🖱 Click to select block  ·  Esc to cancel';
  document.body.appendChild(tip);

  function getSelector(el) {
    if (el.id) return '#' + CSS.escape(el.id);
    const path = [];
    let cur = el;
    while (cur && cur !== document.documentElement) {
      let seg = cur.tagName.toLowerCase();
      if (cur.id) { seg = '#' + CSS.escape(cur.id); path.unshift(seg); break; }
      const siblings = cur.parentElement
        ? Array.from(cur.parentElement.children).filter(s => s.tagName === cur.tagName)
        : [];
      if (siblings.length > 1) seg += ':nth-of-type(' + (siblings.indexOf(cur) + 1) + ')';
      path.unshift(seg);
      cur = cur.parentElement;
    }
    return path.join(' > ');
  }

  function onOver(e) {
    if (_last && _last !== e.target) _last.style.outline = '';
    _last = e.target;
    _last.style.outline = OUTLINE_HOVER;
    e.stopPropagation();
  }

  function onClick(e) {
    e.preventDefault();
    e.stopPropagation();
    const sel = getSelector(e.target);
    e.target.style.outline = OUTLINE;
    cleanup(false);
    chrome.runtime.sendMessage({ type: 'block-picked', selector: sel });
  }

  function onKey(e) {
    if (e.key === 'Escape') { cleanup(true); chrome.runtime.sendMessage({ type: 'block-pick-cancelled' }); }
  }

  function cleanup(resetOutline) {
    document.removeEventListener('mouseover', onOver, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKey, true);
    if (resetOutline && _last) _last.style.outline = '';
    tip.remove();
    window.__mdPickerActive = false;
  }

  document.addEventListener('mouseover', onOver, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKey, true);

  // allow popup to cancel
  chrome.runtime.onMessage.addListener(function handler(msg) {
    if (msg.type === 'cancel-block-picker') { cleanup(true); chrome.runtime.onMessage.removeListener(handler); }
  });
})();
