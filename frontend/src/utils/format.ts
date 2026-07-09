/**
 * Format minor-unit amount for display.
 * Uses Intl.NumberFormat for correct decimal handling per currency.
 */
export function formatAmount(minorUnits: number, currency: string): string {
  const upper = currency.toUpperCase();

  // Currencies with 0 decimal places
  const zeroDecimal = ['JPY', 'KRW', 'VND', 'CLP', 'ISK', 'UGX', 'RWF'];
  // Currencies with 3 decimal places
  const threeDecimal = ['BHD', 'KWD', 'OMR', 'TND'];

  let decimals = 2;
  if (zeroDecimal.includes(upper)) decimals = 0;
  else if (threeDecimal.includes(upper)) decimals = 3;

  const major = minorUnits / Math.pow(10, decimals);

  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: upper,
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(major);
}
