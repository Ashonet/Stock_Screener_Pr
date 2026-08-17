/**
 * Minimal DOM builders.
 *
 * Everything user- or API-supplied (company names, sector labels, search
 * results) goes in as `textContent`, never as an HTML string, so untrusted
 * text can never become markup.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

function applyProps(node, props) {
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.setAttribute('class', value);
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'text') node.textContent = String(value);
    else node.setAttribute(key, value === true ? '' : String(value));
  }
}

function appendChildren(node, children) {
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

/** `el('div', { class: 'card' }, 'text', childNode)` */
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  applyProps(node, props);
  appendChildren(node, children);
  return node;
}

/** Same, in the SVG namespace. */
export function svg(tag, props = {}, ...children) {
  const node = document.createElementNS(SVG_NS, tag);
  applyProps(node, props);
  appendChildren(node, children);
  return node;
}

export function clear(node) {
  node.replaceChildren();
  return node;
}

/** Replace a container's contents in one paint. */
export function render(container, ...children) {
  const frag = document.createDocumentFragment();
  appendChildren(frag, children);
  container.replaceChildren(frag);
  return container;
}

/** Trailing-edge debounce. */
export function debounce(fn, wait) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}
