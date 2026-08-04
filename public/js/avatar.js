/**
 * Player avatars: a monogram chip — the first initial on a circle coloured from
 * the number-card ramp by seat. Deterministic, so the same player looks the same
 * in the standings, the summaries and the feed, on every phone.
 */

/** Which ramp colour a seat gets. Spaced out so neighbouring seats differ. */
export function seatHue(order = 0) {
  return (((order * 5) % 13) + 13) % 13;
}

/** The seat's colour as a CSS value, straight off the --n* card ramp. */
export function seatColor(order = 0) {
  return `var(--n${seatHue(order)})`;
}

/** A small circle with the player's initial, coloured by seat. */
export function monogram(name, order = 0) {
  const el = document.createElement('span');
  el.className = 'monogram';
  const hue = seatHue(order);
  el.dataset.seat = String(hue);
  el.style.setProperty('--c', `var(--n${hue})`);
  el.textContent = (String(name ?? '').trim()[0] ?? '?').toUpperCase();
  // Decoration: the name is always written out next to it.
  el.setAttribute('aria-hidden', 'true');
  return el;
}
