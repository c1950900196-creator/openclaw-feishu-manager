const { TOKEN_PRICING } = require('./config');

function estimateCost(model, input, output, cacheRead) {
  const pricing = TOKEN_PRICING[model];
  if (!pricing) return 0;
  return (input * pricing.input + output * pricing.output + (cacheRead || 0) * pricing.cacheRead) / 1000000;
}

module.exports = { estimateCost };
