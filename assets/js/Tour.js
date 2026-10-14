/**
 * Getting started: a welcome dialog and a skippable walkthrough.
 *
 * Shared, byte for byte, between CritLab and CrossLab. Each app supplies its
 * own words and its own steps; this file only knows how to show them.
 *
 *   Tour.dialog({ title, body, actions: [{ label, primary, href, onClick }] })
 *   Tour.start(steps, { onEnd(reason) })      reason: 'done' | 'skip'
 *
 * A step is { el: selector or element, title, body }. Steps whose element is
 * missing or not laid out (a panel hidden on a phone) are passed over, so the
 * same list works at every width.
 */
const Tour = (() => {
  'use strict';

  let layer = null;   // the single overlay in use, dialog or tour
  let keyHandler = null;

  function esc(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function close() {
    if (keyHandler) { document.removeEventListener('keydown', keyHandler); keyHandler = null; }
    document.querySelectorAll('.tour-target').forEach(e => e.classList.remove('tour-target'));
    if (layer) { layer.remove(); layer = null; }
  }

  function isOpen() { return !!layer; }

  function button(a) {
    const b = document.createElement(a.href ? 'a' : 'button');
    b.className = 'btn' + (a.primary ? ' btn-primary' : '');
    b.textContent = a.label;
    if (a.href) b.href = a.href;
    if (a.id) b.id = a.id;
    return b;
  }

  /** A centred modal with a title, HTML body and a row of actions. */
  function dialog({ title, body, actions = [], onDismiss }) {
    close();
    layer = document.createElement('div');
    layer.className = 'tour-layer';
    layer.innerHTML =
      '<div class="tour-backdrop"></div>' +
      '<div class="tour-dialog" role="dialog" aria-modal="true" aria-labelledby="tour-title">' +
        '<div class="tour-title" id="tour-title">' + esc(title) + '</div>' +
        '<div class="tour-body">' + body + '</div>' +
        '<div class="btn-row tour-actions"></div>' +
      '</div>';
    const row = layer.querySelector('.tour-actions');
    for (const a of actions) {
      const b = button(a);
      b.addEventListener('click', e => {
        if (a.onClick) { e.preventDefault(); close(); a.onClick(); }
        else if (!a.href) close();
      });
      row.appendChild(b);
    }
    document.body.appendChild(layer);
    keyHandler = e => { if (e.key === 'Escape') { close(); if (onDismiss) onDismiss(); } };
    document.addEventListener('keydown', keyHandler);
    const first = row.querySelector('.btn-primary') || row.firstChild;
    if (first) first.focus();
    return layer;
  }

  function resolve(el) {
    const node = typeof el === 'string' ? document.querySelector(el) : el;
    if (!node) return null;
    // offsetWidth is 0 for anything under display:none — a panel hidden at this width.
    if (!node.offsetWidth && !node.offsetHeight) return null;
    return node;
  }

  /** Walk through `steps`, pointing at each element in turn. */
  function start(steps, { onEnd } = {}) {
    const live = steps.filter(s => !s.el || resolve(s.el));
    if (!live.length) { if (onEnd) onEnd('done'); return; }
    let i = 0;

    close();
    layer = document.createElement('div');
    layer.className = 'tour-layer tour-walk';
    layer.innerHTML =
      '<div class="tour-spot"></div>' +
      '<div class="tour-pop" role="dialog" aria-modal="false" aria-labelledby="tour-title">' +
        '<div class="tour-count"></div>' +
        '<div class="tour-title" id="tour-title"></div>' +
        '<div class="tour-body"></div>' +
        '<div class="tour-actions">' +
          '<button class="btn btn-sm tour-skip" id="tour-skip">Skip tour</button>' +
          '<span class="tour-gap"></span>' +
          '<button class="btn btn-sm" id="tour-back">Back</button>' +
          '<button class="btn btn-sm btn-primary" id="tour-next">Next</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(layer);
    const pop = layer.querySelector('.tour-pop');
    const spot = layer.querySelector('.tour-spot');

    function end(reason) { close(); window.removeEventListener('resize', place); if (onEnd) onEnd(reason); }

    function place() {
      if (!layer) return;
      const s = live[i];
      const node = s.el ? resolve(s.el) : null;
      pop.classList.toggle('tour-pop-free', !node);
      spot.style.display = node ? '' : 'none';
      if (!node) { pop.style.left = pop.style.top = ''; return; }
      const r = node.getBoundingClientRect();
      const vw = window.innerWidth, vh = window.innerHeight;
      // The spotlight is a hole in the dimming, drawn in the overlay rather than
      // on the target, so no overflow:hidden ancestor can clip it.
      spot.style.left = (r.left - 4) + 'px';
      spot.style.top = (r.top - 4) + 'px';
      spot.style.width = (r.width + 8) + 'px';
      spot.style.height = (r.height + 8) + 'px';
      const pw = pop.offsetWidth || 300, ph = pop.offsetHeight || 160;
      if (vw < 600) {
        // A sheet along the edge away from the target.
        pop.style.left = pop.style.top = '';
        pop.classList.add('tour-pop-dock');
        pop.classList.toggle('tour-pop-dock-top', r.top + r.height / 2 > vh / 2);
        return;
      }
      pop.classList.remove('tour-pop-dock', 'tour-pop-dock-top');
      // Beside the target if it fits (right, then left), else below, else above;
      // always on screen.
      let left, top;
      if (r.right + 12 + pw <= vw) { left = r.right + 12; top = r.top; }
      else if (r.left - 12 - pw >= 0) { left = r.left - 12 - pw; top = r.top; }
      else if (r.bottom + 12 + ph <= vh) { left = r.left; top = r.bottom + 12; }
      else { left = r.left; top = r.top - 12 - ph; }
      pop.style.left = Math.max(8, Math.min(left, vw - pw - 8)) + 'px';
      pop.style.top = Math.max(8, Math.min(top, vh - ph - 8)) + 'px';
    }

    function show() {
      const s = live[i];
      document.querySelectorAll('.tour-target').forEach(e => e.classList.remove('tour-target'));
      const node = s.el ? resolve(s.el) : null;
      if (node) {
        node.classList.add('tour-target');
        if (node.scrollIntoView) node.scrollIntoView({ block: 'nearest' });
      }
      pop.querySelector('.tour-count').textContent = (i + 1) + ' of ' + live.length;
      pop.querySelector('.tour-title').textContent = s.title;
      pop.querySelector('.tour-body').innerHTML = s.body;
      layer.querySelector('#tour-back').disabled = i === 0;
      layer.querySelector('#tour-next').textContent = i === live.length - 1 ? 'Done' : 'Next';
      place();
      layer.querySelector('#tour-next').focus();
    }

    layer.querySelector('#tour-skip').addEventListener('click', () => end('skip'));
    layer.querySelector('#tour-back').addEventListener('click', () => { if (i > 0) { i--; show(); } });
    layer.querySelector('#tour-next').addEventListener('click', () => {
      if (i < live.length - 1) { i++; show(); } else end('done');
    });
    keyHandler = e => {
      if (e.key === 'Escape') end('skip');
      else if (e.key === 'ArrowRight') layer.querySelector('#tour-next').click();
      else if (e.key === 'ArrowLeft') layer.querySelector('#tour-back').click();
    };
    document.addEventListener('keydown', keyHandler);
    window.addEventListener('resize', place);
    show();
  }

  return { dialog, start, close, isOpen };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Tour;
