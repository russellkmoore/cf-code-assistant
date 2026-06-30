/**
 * TypeScript type definitions for cart.js
 * Shopping cart module with item and discount management
 */

/**
 * Represents a single item in the shopping cart
 */
interface CartItem {
  /** Product SKU (stock keeping unit) identifier */
  sku: string;
  /** Product name or title */
  name: string;
  /** Price per unit in cents or currency units */
  price: number;
  /** Quantity of this item in the cart */
  qty: number;
}

/**
 * Represents a discount code applied to the cart
 */
interface DiscountCode {
  /** The discount code string */
  code: string;
  /** Discount percentage (0-100) */
  percent: number;
}

/**
 * Represents the complete shopping cart state
 */
interface Cart {
  /** Array of items currently in the cart */
  items: CartItem[];
  /** Currently applied discount code, or null if none applied */
  discountCode: DiscountCode | null;
}

/**
 * Creates a new empty shopping cart
 * @returns A new Cart object with empty items array and no discount applied
 */
export function createCart(): Cart;

/**
 * Adds an item to the cart, or increments quantity if item already exists
 * @param cart - The cart to add to
 * @param sku - Product SKU identifier
 * @param name - Product name
 * @param price - Price per unit
 * @param qty - Quantity to add
 * @returns The modified cart object
 */
export function addItem(
  cart: Cart,
  sku: string,
  name: string,
  price: number,
  qty: number
): Cart;

/**
 * Removes an item from the cart by SKU
 * @param cart - The cart to remove from
 * @param sku - SKU of the item to remove
 * @returns The modified cart object
 */
export function removeItem(cart: Cart, sku: string): Cart;

/**
 * Applies a discount code to the cart
 * @param cart - The cart to apply discount to
 * @param code - The discount code string
 * @param percent - The discount percentage (0-100)
 * @returns The modified cart object
 */
export function applyDiscount(
  cart: Cart,
  code: string,
  percent: number
): Cart;

/**
 * Calculates the subtotal of all items before discount
 * @param cart - The cart to calculate subtotal for
 * @returns The subtotal amount (sum of price * qty for all items)
 */
export function subtotal(cart: Cart): number;

/**
 * Calculates the total price after applying any discount
 * @param cart - The cart to calculate total for
 * @returns The total amount after discount is applied
 */
export function total(cart: Cart): number;
