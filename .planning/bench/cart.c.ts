interface CartItem {
  sku: string;
  name: string;
  price: number;
  qty: number;
}

interface Discount {
  code: string;
  percent: number;
}

interface Cart {
  items: CartItem[];
  discountCode: Discount | null;
}

export function createCart(): Cart {
  return { items: [], discountCode: null };
}

export function addItem(cart: Cart, sku: string, name: string, price: number, qty: number): Cart {
  const existing = cart.items.find((i) => i.sku === sku);
  if (existing) {
    existing.qty += qty;
  } else {
    cart.items.push({ sku, name, price, qty });
  }
  return cart;
}

export function removeItem(cart: Cart, sku: string): Cart {
  cart.items = cart.items.filter((i) => i.sku !== sku);
  return cart;
}

export function applyDiscount(cart: Cart, code: string, percent: number): Cart {
  cart.discountCode = { code, percent };
  return cart;
}

export function subtotal(cart: Cart): number {
  return cart.items.reduce((sum, i) => sum + i.price * i.qty, 0);
}

export function total(cart: Cart): number {
  const sub = subtotal(cart);
  const pct = cart.discountCode ? cart.discountCode.percent : 0;
  return sub - sub * (pct / 100);
}
