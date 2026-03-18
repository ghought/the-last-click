// The secret maximum number of clicks before the button breaks.
// Change this before deploying. Nobody should ever see this number.
export const MAX_CLICKS = parseInt(process.env.MAX_CLICKS, 10) || 20000;
export const PORT = process.env.PORT || 3000;
