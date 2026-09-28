import { esc } from '../util.js';

export function placeholder(id, title, icon, blurb) {
  return {
    id, title, icon,
    render(el) {
      el.innerHTML = `
        <div class="empty">
          <div class="empty-icon" aria-hidden="true">${icon}</div>
          <h2>${esc(title)} is coming soon</h2>
          <p>${esc(blurb)}</p>
        </div>`;
    },
  };
}
