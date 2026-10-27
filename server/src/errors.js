// Errors the app may read: an HTTP status, a stable machine code and a short message. The app shows its own copy
// (app/src/copy.ts) by code; these lines follow the same rules (short, plain, affirmative).
export const TEXT = {
  signIn: 'Sign in first.',
  slow: 'Slow down a bit.',
  badMint: 'Check the coin address.',
  badAddress: 'Check the wallet address.',
  badSignIn: 'Sign in again.',
  badSignature: 'Sign in again.',
  expired: 'Sign in again.',
  unknownCoin: 'This coin is missing here.',
  badJson: 'Send JSON.',
  tooLarge: 'The request is too big.',
  busy: 'The network is busy. Try again.',
  hidden: 'This coin stays off flipfee.',
  notFound: 'This page is missing.',
  server: 'Server error. Try again.',
  badSide: 'Pick bid or ask.',
  badPrice: 'Set a price from 0.0001 to 1000 SOL.',
  badHours: 'Pick 1 to 24 hours.',
  crosses: 'This price meets the other side. Pick another price.',
  tooManyOrders: 'You have the most orders open. Cancel one first.',
  noOrder: 'This order is gone.',
};

export function httpError(status, code, message = TEXT[code] ?? code) {
  const e = new Error(message);
  e.status = status;
  e.code = code;
  e.expose = true;
  return e;
}
