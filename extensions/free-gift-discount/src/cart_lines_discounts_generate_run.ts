import {
  DiscountClass,
  ProductDiscountSelectionStrategy,
  CartInput,
  CartLinesDiscountsGenerateRunResult,
} from '../generated/api';


export function cartLinesDiscountsGenerateRun(
  input: CartInput,
): CartLinesDiscountsGenerateRunResult {
  if (!input.cart.lines.length) {
    return {operations: []};
  }

  const hasOrderDiscountClass = input.discount.discountClasses.includes(
    DiscountClass.Order,
  );
  const hasProductDiscountClass = input.discount.discountClasses.includes(
    DiscountClass.Product,
  );

  if (!hasOrderDiscountClass && !hasProductDiscountClass) {
    return {operations: []};
  }

  const operations = [];
  const giftLines = input.cart.lines.filter((line) => line.freeGift?.value === '1');

  if (hasProductDiscountClass && giftLines.length) {
    operations.push({
      productDiscountsAdd: {
        candidates: [
          {
            message: 'Free gift',
            targets: giftLines.map((line) => ({
              cartLine: {
                id: line.id,
              },
            })),
            value: {
              percentage: {
                value: 100,
              },
            },
          },
        ],
        selectionStrategy: ProductDiscountSelectionStrategy.First,
      },
    });
  }

  return {
    operations,
  };
}
