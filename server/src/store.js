// Armazenamento em memória (placeholder). Trocar por banco de dados antes de produção.
const orders = new Map();

const cents = (n) => Math.round(n * 100);

// Comissão e repasse calculados em centavos para evitar erro de ponto flutuante.
function split(amount, feePercent) {
  const total = cents(amount);
  const fee = Math.round((total * feePercent) / 100);
  return { fee: fee / 100, payout: (total - fee) / 100 };
}

module.exports = { orders, split };
