// Untyped shopping-cart module — benchmark fixture for generateTypes.
export function createCart() {
  return { items: [], discountCode: null };
}

export function addItem(cart, sku, name, price, qty) {
  const existing = cart.items.find((i) => i.sku === sku);
  if (existing) {
    existing.qty += qty;
  } else {
    cart.items.push({ sku, name, price, qty });
  }
  return cart;
}

export function removeItem(cart, sku) {
  cart.items = cart.items.filter((i) => i.sku !== sku);
  return cart;
}

export function applyDiscount(cart, code, percent) {
  cart.discountCode = { code, percent };
  return cart;
}

export function subtotal(cart) {
  return cart.items.reduce((sum, i) => sum + i.price * i.qty, 0);
}

export function total(cart) {
  const sub = subtotal(cart);
  const pct = cart.discountCode ? cart.discountCode.percent : 0;
  return sub - sub * (pct / 100);
}
