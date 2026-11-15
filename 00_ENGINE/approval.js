'use strict';
/**
 * Renderer for the approval popup. Uses textContent only. No innerHTML.
 * The kernel is the authority: this script can only send APPROVE or REJECT for the id it was shown.
 */
const APPROVE_ARM_MS = 1500;

let current = null; // { id, deadline, total, armedAt }
let tick = null;

const $ = (id) => document.getElementById(id);
const setText = (id, v) => { $(id).textContent = v == null ? '' : String(v); };

function clear() {
  current = null;
  if (tick) { clearInterval(tick); tick = null; }
  $('card').hidden = true;
  $('approve').disabled = true;
}

function update() {
  if (!current) return;
  const now = Date.now();
  const left = Math.max(0, current.deadline - now);
  setText('secs', Math.ceil(left / 1000));
  $('bar').style.width = `${(100 * left) / current.total}%`;
  $('approve').disabled = now < current.armedAt;
}

function show(p) {
  if (!p || typeof p.id !== 'string') return;
  clear();
  const now = Date.now();
  current = {
    id: p.id,
    deadline: now + Number(p.timeout_ms || 60000),
    total: Number(p.timeout_ms || 60000),
    armedAt: now + APPROVE_ARM_MS,
  };
  setText('risk', p.risk_level || 'RISKY');
  setText('module', p.module);
  setText('action', p.action);
  setText('target', p.target);
  setText('summary', p.summary);
  setText('presence', p.presence === 'IDLE' ? 'User away' : (p.presence === 'ACTIVE' ? 'User active' : ''));
  $('idleNote').hidden = p.presence !== 'IDLE';
  $('card').hidden = false;
  $('reject').focus();
  tick = setInterval(update, 100);
  update();
}

function respond(decision) {
  if (!current) return;
  if (decision === 'APPROVE' && Date.now() < current.armedAt) return;
  const id = current.id;
  clear();
  window.approval.respond(id, decision);
}

window.approval.onShow(show);
window.approval.onHide(clear);

$('approve').addEventListener('click', () => respond('APPROVE'));
$('reject').addEventListener('click', () => respond('REJECT'));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.preventDefault(); respond('REJECT'); }
});