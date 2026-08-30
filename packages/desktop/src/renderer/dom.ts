/**
 * A three-line element builder, used everywhere instead of template strings.
 *
 * Every value that reaches this screen - titles, bodies, hub names - was
 * written by whatever is sending alerts, and routinely carries stack traces
 * and user input. Text goes in through `textContent` and never through
 * `innerHTML`, so the alerting client cannot become a delivery mechanism for
 * whatever an attacker managed to get logged.
 */
type Attrs = Record<string, string | boolean | number | undefined>;
type Child = Node | string | false | null | undefined;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue;
    if (key === 'class') node.className = String(value);
    else if (key === 'text') node.textContent = String(value);
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children) {
    if (child === false || child === null || child === undefined) continue;
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

/** A labelled on/off switch, matching the phone's settings rows. */
export function toggle(checked: boolean, onChange: (value: boolean) => void): HTMLElement {
  const input = el('input', { type: 'checkbox', class: 'toggle-input' });
  input.checked = checked;
  input.addEventListener('change', () => onChange(input.checked));
  return el('label', { class: 'toggle' }, input, el('span', { class: 'toggle-track' }));
}

export function button(
  label: string,
  onClick: () => void,
  attrs: Attrs = {},
): HTMLButtonElement {
  const node = el('button', { type: 'button', ...attrs }, label);
  node.addEventListener('click', onClick);
  return node;
}
