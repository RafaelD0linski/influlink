require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { MercadoPagoConfig, Preference, Payment } = require('mercadopago');

const {
  PORT = 3000,
  FRONTEND_URL = 'http://localhost:5173',
  PUBLIC_URL,
  MP_ACCESS_TOKEN,
  MP_WEBHOOK_SECRET,
  PLATFORM_FEE_PERCENT = '9',
} = process.env;

if (!MP_ACCESS_TOKEN) console.warn('[aviso] MP_ACCESS_TOKEN não definido — rotas de pagamento vão falhar.');

const mp = new MercadoPagoConfig({ accessToken: MP_ACCESS_TOKEN || 'missing' });
const app = express();
app.use(cors({ origin: FRONTEND_URL }));
app.use(express.json());

// Armazenamento em memória (placeholder). Trocar por banco de dados antes de ir a produção.
const orders = new Map();

const feePercent = Number(PLATFORM_FEE_PERCENT);
const split = (amount) => {
  const fee = Math.round(amount * feePercent) / 100;
  return { fee, payout: Math.round((amount - fee) * 100) / 100 };
};

app.get('/api/health', (_req, res) => res.json({ ok: true }));

// Cria uma preferência do Checkout Pro e devolve o link de pagamento.
// body: { title, amount, influencerId, brandId }
app.post('/api/payments/preference', async (req, res) => {
  const { title, amount, influencerId, brandId } = req.body || {};
  const value = Number(amount);
  if (!title || !Number.isFinite(value) || value < 1) {
    return res.status(400).json({ error: 'title e amount (>= 1) são obrigatórios' });
  }

  const orderId = crypto.randomUUID();
  const { fee, payout } = split(value);
  orders.set(orderId, { orderId, title, amount: value, fee, payout, influencerId, brandId, status: 'pending' });

  try {
    const pref = await new Preference(mp).create({
      body: {
        items: [{ id: orderId, title, quantity: 1, unit_price: value, currency_id: 'BRL' }],
        external_reference: orderId,
        back_urls: {
          success: `${FRONTEND_URL}/?pagamento=sucesso`,
          pending: `${FRONTEND_URL}/?pagamento=pendente`,
          failure: `${FRONTEND_URL}/?pagamento=falha`,
        },
        auto_return: 'approved',
        notification_url: PUBLIC_URL ? `${PUBLIC_URL}/api/webhooks/mercadopago` : undefined,
      },
    });
    res.json({ orderId, fee, payout, initPoint: pref.init_point, sandboxInitPoint: pref.sandbox_init_point });
  } catch (err) {
    console.error('[mp] erro ao criar preferência:', err.message);
    res.status(502).json({ error: 'Falha ao criar pagamento no Mercado Pago' });
  }
});

app.get('/api/orders/:id', (req, res) => {
  const order = orders.get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Pedido não encontrado' });
  res.json(order);
});

// Valida a assinatura x-signature enviada pelo Mercado Pago.
function validSignature(req) {
  if (!MP_WEBHOOK_SECRET) return true; // sem segredo configurado: só aceitável em dev
  const sig = req.get('x-signature') || '';
  const requestId = req.get('x-request-id') || '';
  const parts = Object.fromEntries(sig.split(',').map((p) => p.trim().split('=')));
  const dataId = String(req.query['data.id'] || req.body?.data?.id || '').toLowerCase();
  const manifest = `id:${dataId};request-id:${requestId};ts:${parts.ts};`;
  const expected = crypto.createHmac('sha256', MP_WEBHOOK_SECRET).update(manifest).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(parts.v1 || '');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Webhook: o MP avisa mudanças de pagamento; consultamos o pagamento na API (nunca confiar só no corpo).
app.post('/api/webhooks/mercadopago', async (req, res) => {
  if (!validSignature(req)) return res.sendStatus(401);
  res.sendStatus(200); // responde rápido; processa em seguida

  const type = req.body?.type || req.query.type;
  const paymentId = req.body?.data?.id || req.query['data.id'];
  if (type !== 'payment' || !paymentId) return;

  try {
    const payment = await new Payment(mp).get({ id: paymentId });
    const order = orders.get(payment.external_reference);
    if (!order) return;
    order.status = payment.status; // approved | pending | rejected | refunded ...
    order.paymentId = payment.id;
    console.log(`[webhook] pedido ${order.orderId} -> ${payment.status}`);
    // TODO: se approved, liberar custódia/repasse de `order.payout` ao divulgador após aprovação da entrega.
  } catch (err) {
    console.error('[webhook] erro ao consultar pagamento:', err.message);
  }
});

app.listen(PORT, () => console.log(`API Influlink em http://localhost:${PORT}`));
