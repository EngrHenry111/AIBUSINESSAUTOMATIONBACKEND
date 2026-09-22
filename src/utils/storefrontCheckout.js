'use strict';

const { AppError } = require('../middleware/errorMiddleware');

/**
 * Resolves one cart line against the real Product document — never trusts a
 * client-supplied price. If the cart item names a variant (variantGroup +
 * variantValue), that option's price/stock override the base product.
 *
 * Note: a product can define several independent variant groups (e.g. both
 * "Size" and "Color"), but this resolves against ONE group at a time — a
 * shopper picks a single variant per line item in this pass, not a
 * Size×Color combinatorial matrix. That's a deliberate scope cut, not a bug.
 */
function resolveLineItem(product, cartItem) {
  const qty = Math.max(1, parseInt(cartItem.quantity, 10) || 0);
  let unitPrice = product.effectivePrice ? product.effectivePrice() : product.price;
  let availableStock = product.stock?.trackStock ? product.stock.quantity : Infinity;
  let allowOutOfStock = Boolean(product.stock?.allowOutOfStock);
  let variantLabel = null;
  let sku = product.sku;

  if (cartItem.variantGroup && cartItem.variantValue) {
    const group = (product.variants || []).find((v) => v.name === cartItem.variantGroup);
    const option = group?.options?.find((o) => o.value === cartItem.variantValue);
    if (!group || !option) {
      throw new AppError(`The selected option for "${product.name}" is no longer available.`, 400);
    }
    if (option.price != null) unitPrice = option.price;
    if (option.stock != null) { availableStock = option.stock; allowOutOfStock = false; }
    if (option.sku) sku = option.sku;
    variantLabel = `${group.name}: ${option.value}`;
  }

  if (availableStock !== Infinity && !allowOutOfStock && availableStock < qty) {
    throw new AppError(`Only ${availableStock} of "${product.name}"${variantLabel ? ` (${variantLabel})` : ''} left in stock.`, 400);
  }

  return {
    productId: product._id,
    name: product.name,
    image: product.images?.[0] || null,
    variant: variantLabel,
    quantity: qty,
    price: unitPrice,
    total: unitPrice * qty,
    sku: sku || undefined,
  };
}

/** Delivery fee by shipping state, with an optional free-delivery threshold. */
function computeDeliveryFee(company, subtotal, state) {
  const ds = company.deliverySettings || {};
  if (ds.freeDeliveryMinimum != null && subtotal >= ds.freeDeliveryMinimum) return 0;
  const fees = ds.feesByState instanceof Map ? ds.feesByState : new Map(Object.entries(ds.feesByState || {}));
  if (state && fees.has(state)) return fees.get(state);
  return ds.defaultFee ?? 2000;
}

/**
 * Validates a coupon against an order subtotal and returns the discount.
 * Throws AppError with a shopper-facing message on any failure — callers
 * (both the /coupon/validate endpoint and checkout itself) show it as-is.
 */
function applyCoupon(coupon, subtotal, productIds = []) {
  if (!coupon || !coupon.isActive) throw new AppError('This coupon code is not valid.', 400);
  if (coupon.expiresAt && coupon.expiresAt < new Date()) throw new AppError('This coupon has expired.', 400);
  if (coupon.usageLimit != null && coupon.usedCount >= coupon.usageLimit) throw new AppError('This coupon has reached its usage limit.', 400);
  if (subtotal < (coupon.minimumOrder || 0)) throw new AppError(`This coupon requires a minimum order of ${Number(coupon.minimumOrder).toLocaleString()}.`, 400);

  if (coupon.applicableProducts?.length) {
    const applicable = new Set(coupon.applicableProducts.map(String));
    const hasApplicable = productIds.some((id) => applicable.has(String(id)));
    if (!hasApplicable) throw new AppError('This coupon does not apply to the items in your cart.', 400);
  }

  let discount = coupon.type === 'percentage' ? (subtotal * coupon.value) / 100 : coupon.value;
  if (coupon.maximumDiscount != null) discount = Math.min(discount, coupon.maximumDiscount);
  discount = Math.min(discount, subtotal - 1); // never discount to exactly zero/negative
  return Math.max(0, Math.round(discount * 100) / 100);
}

module.exports = { resolveLineItem, computeDeliveryFee, applyCoupon };
