const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { MercadoPagoConfig, Payment } = require('mercadopago');
const { config, validate, summary } = require('./config');
const { orders, split } = require('./store');

const { errors, warnings } = validate();
warnings.forEach((w) => console.warn(`[aviso] ${w}`));
if (errors.length) {
  errors.forEach((e) => console.error(`[erro] ${e}`));
  console.error('Configure server/.env (veja .env.example). Encerrando.');
  process.exit(1);
}
console.log('[config]', summary());

const mp = new MercadoPagoConfig({ accessToken: config.mp.accessToken, options: { timeout: 10000 } });
const payments = new Payment(mp);

const app = express();
app.use(cors({ origin: config.frontendUrl }));
app.use(express.json({ limit: '50kb' }));

const notificationUrl = config.publicUrl ? `${config.publicUrl}/api/webhooks/mercadopago` : undefined;
const onlyDigits = (s) => String(s || '').replace(/\D/g, '');
const validEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || ''));

function cpfValid(raw) {
  const c = onlyDigits(raw);
  if (c.length !== 11 || /^(\d)\1+$/.test(c)) return false;
  const dv = (len) => {
    let sum = 0;
    for (let i = 0; i < len; i++) sum += Number(c[i]) * (len + 1 - i);
    const r = (sum * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return dv(9) === Number(c[9]) && dv(10) === Number(c[10]);
}

function buildPayer(payer = {}) {
  if (!validEmail(payer.email)) return { error: 'payer.email inválido' };
  if (!cpfValid(payer.cpf)) return { error: 'payer.cpf inválido' };
  return {
    payer: {
      email: payer.email,
      first_name: payer.firstName,
      last_name: payer.lastName,
      identification: { type: 'CPF', number: onlyDigits(payer.cpf) },
    },
  };
}

const idemKey = (req, order, kind) => req.get('x-idempotency-key') || `${order.orderId}-${kind}-${crypto.randomUUID()}`;

function mpError(res, err, what) {
  // Não vaza detalhes internos nem credenciais ao cliente.
  console.error(`[mp] ${what}:`, err?.message, err?.cause ? JSON.stringify(err.cause) : '');
  res.status(502).json({ error: `Falha ao ${what} no Mercado Pago` });
}

app.get('/api/health', (_req, res) => res.json({ ok: true }));

// Só a chave pública sai daqui — é ela que o front usa no MercadoPago.js para tokenizar o cartão.
app.get('/api/config', (_req, res) => res.json({ publicKey: config.mp.publicKey, feePercent: config.feePercent }));

// 1) Cria o pedido. O valor fica salvo NO SERVIDOR e os pagamentos usam esse valor (o cliente não escolhe o preço).
app.post('/api/orders', (req, res) => {
  const { title, amount, influencerId, brandId } = req.body || {};
  const value = Number(amount);
  if (!title || !Number.isFinite(value) || value < 1 || value > 100000) {
    return res.status(400).json({ error: 'title e amount (1 a 100000) são obrigatórios' });
  }
  const orderId = crypto.randomUUID();
  const order = { orderId, title: String(title).slice(0, 120), amount: value, ...split(value, config.feePercent), influencerId, brandId, status: 'created' };
  orders.set(orderId, order);
  res.status(201).json(order);
});

app.get('/api/orders/:id', (req, res) => {
  const order = orders.get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Pedido não encontrado' });
  res.json(order);
});

function loadPayable(req, res) {
  const order = orders.get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Pedido não encontrado' }), null;
  if (order.status === 'approved') return res.status(409).json({ error: 'Pedido já pago' }), null;
  return order;
}

// 2) Pix: devolve QR Code (imagem base64) e "copia e cola". Expira em 30 min.
// body: { payer: { email, firstName, lastName, cpf } }
app.post('/api/orders/:id/pix', async (req, res) => {
  const order = loadPayable(req, res);
  if (!order) return;
  const { payer, error } = buildPayer(req.body?.payer);
  if (error) return res.status(400).json({ error });

  try {
    const p = await payments.create({
      body: {
        transaction_amount: order.amount,
        description: order.title,
        payment_method_id: 'pix',
        payer,
        external_reference: order.orderId,
        notification_url: notificationUrl,
        date_of_expiration: new Date(Date.now() + 30 * 60 * 1000).toISOString().replace('Z', '+00:00'),
      },
      requestOptions: { idempotencyKey: idemKey(req, order, 'pix') },
    });
    Object.assign(order, { status: p.status, paymentId: p.id, method: 'pix' });
    const tx = p.point_of_interaction?.transaction_data || {};
    res.status(201).json({
      paymentId: p.id,
      status: p.status,
      qrCode: tx.qr_code,
      qrCodeBase64: tx.qr_code_base64,
      ticketUrl: tx.ticket_url,
      expiresAt: p.date_of_expiration,
    });
  } catch (err) {
    mpError(res, err, 'gerar Pix');
  }
});

// 3) Cartão de crédito: o número do cartão NUNCA passa por aqui — o front gera `token` com MercadoPago.js.
// body: { token, paymentMethodId, issuerId, installments, payer: { email, cpf, ... } }
app.post('/api/orders/:id/card', async (req, res) => {
  const order = loadPayable(req, res);
  if (!order) return;
  const { token, paymentMethodId, issuerId, installments } = req.body || {};
  if (!token || !paymentMethodId) return res.status(400).json({ error: 'token e paymentMethodId são obrigatórios' });
  const parcelas = Number(installments || 1);
  if (!Number.isInteger(parcelas) || parcelas < 1 || parcelas > 12) return res.status(400).json({ error: 'installments inválido (1 a 12)' });
  const { payer, error } = buildPayer(req.body?.payer);
  if (error) return res.status(400).json({ error });

  try {
    const p = await payments.create({
      body: {
        transaction_amount: order.amount,
        token,
        description: order.title,
        installments: parcelas,
        payment_method_id: paymentMethodId,
        issuer_id: issuerId ? Number(issuerId) : undefined,
        payer,
        external_reference: order.orderId,
        notification_url: notificationUrl,
        statement_descriptor: 'INFLULINK',
      },
      requestOptions: { idempotencyKey: idemKey(req, order, 'card') },
    });
    Object.assign(order, { status: p.status, paymentId: p.id, method: 'card' });
    res.status(201).json({ paymentId: p.id, status: p.status, statusDetail: p.status_detail });
  } catch (err) {
    mpError(res, err, 'processar cartão');
  }
});

// Valida a assinatura x-signature enviada pelo Mercado Pago.
function validSignature(req) {
  if (!config.mp.webhookSecret) return true; // só aceitável em dev (em produção o config exige o segredo)
  const parts = Object.fromEntries((req.get('x-signature') || '').split(',').map((p) => p.trim().split('=')));
  const dataId = String(req.query['data.id'] || req.body?.data?.id || '').toLowerCase();
  const manifest = `id:${dataId};request-id:${req.get('x-request-id') || ''};ts:${parts.ts};`;
  const expected = Buffer.from(crypto.createHmac('sha256', config.mp.webhookSecret).update(manifest).digest('hex'));
  const got = Buffer.from(parts.v1 || '');
  return expected.length === got.length && crypto.timingSafeEqual(expected, got);
}

// Webhook: o MP avisa mudanças; sempre reconsultamos o pagamento na API (nunca confiar só no corpo recebido).
app.post('/api/webhooks/mercadopago', async (req, res) => {
  if (!validSignature(req)) return res.sendStatus(401);
  res.sendStatus(200);

  const type = req.body?.type || req.query.type;
  const paymentId = req.body?.data?.id || req.query['data.id'];
  if (type !== 'payment' || !paymentId) return;

  try {
    const p = await payments.get({ id: paymentId });
    const order = orders.get(p.external_reference);
    if (!order) return;
    order.status = p.status; // approved | pending | in_process | rejected | cancelled | refunded
    order.paymentId = p.id;
    console.log(`[webhook] pedido ${order.orderId} -> ${p.status}`);
    // TODO: quando approved, manter em custódia e liberar `order.payout` após aprovação da entrega.
  } catch (err) {
    console.error('[webhook] erro ao consultar pagamento:', err.message);
  }
});

app.listen(config.port, () => console.log(`API Influlink em http://localhost:${config.port}`));
