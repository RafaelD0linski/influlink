require('dotenv').config();

const env = process.env;
const isProd = env.NODE_ENV === 'production';

// Campos de credenciais do Mercado Pago (painel: Suas integrações > Credenciais).
//  - MP_PUBLIC_KEY      -> pode ir ao navegador (MercadoPago.js tokeniza o cartão com ela)
//  - MP_ACCESS_TOKEN    -> SECRETO, só no servidor (cria pagamentos)
//  - MP_CLIENT_ID / MP_CLIENT_SECRET -> SECRETOS, só necessários para OAuth do modelo Marketplace
//  - MP_WEBHOOK_SECRET  -> SECRETO, valida a assinatura dos webhooks
const mp = {
  publicKey: (env.MP_PUBLIC_KEY || '').trim(),
  accessToken: (env.MP_ACCESS_TOKEN || '').trim(),
  clientId: (env.MP_CLIENT_ID || '').trim(),
  clientSecret: (env.MP_CLIENT_SECRET || '').trim(),
  webhookSecret: (env.MP_WEBHOOK_SECRET || '').trim(),
};

const config = {
  isProd,
  port: Number(env.PORT || 3000),
  frontendUrl: env.FRONTEND_URL || 'http://localhost:5173',
  publicUrl: (env.PUBLIC_URL || '').replace(/\/$/, ''),
  feePercent: Number(env.PLATFORM_FEE_PERCENT || 9),
  mp,
};

const prefix = (v) => (v.startsWith('TEST-') ? 'TEST' : v.startsWith('APP_USR-') ? 'APP_USR' : null);

function validate() {
  const errors = [];
  const warnings = [];

  if (!mp.accessToken) errors.push('MP_ACCESS_TOKEN ausente');
  else if (!prefix(mp.accessToken)) errors.push('MP_ACCESS_TOKEN deve começar com TEST- ou APP_USR-');

  if (!mp.publicKey) errors.push('MP_PUBLIC_KEY ausente');
  else if (!prefix(mp.publicKey)) errors.push('MP_PUBLIC_KEY deve começar com TEST- ou APP_USR-');

  if (prefix(mp.accessToken) && prefix(mp.publicKey) && prefix(mp.accessToken) !== prefix(mp.publicKey)) {
    errors.push('MP_PUBLIC_KEY e MP_ACCESS_TOKEN são de ambientes diferentes (teste x produção)');
  }

  if (!mp.clientId !== !mp.clientSecret) errors.push('MP_CLIENT_ID e MP_CLIENT_SECRET devem ser preenchidos juntos');
  if (!mp.clientId) warnings.push('MP_CLIENT_ID/SECRET vazios: OAuth de divulgadores (split Marketplace) desativado');

  if (!mp.webhookSecret) (isProd ? errors : warnings).push('MP_WEBHOOK_SECRET vazio: webhooks sem validação de assinatura');
  if (!config.publicUrl) warnings.push('PUBLIC_URL vazio: o Mercado Pago não conseguirá chamar o webhook');
  if (!(config.feePercent >= 0 && config.feePercent < 100)) errors.push('PLATFORM_FEE_PERCENT inválido');

  return { errors, warnings };
}

// Resumo seguro para log: nunca imprime o valor dos segredos.
const mask = (v) => (v ? `${v.slice(0, 8)}…(${v.length} chars)` : '(vazio)');
function summary() {
  return {
    // O prefixo APP_USR- vale para teste e produção, então não dá para inferir o ambiente só por ele.
    ambiente: prefix(mp.accessToken) === 'TEST' ? 'teste' : prefix(mp.accessToken) ? 'APP_USR (confirme se é conta de teste)' : 'indefinido',
    publicKey: mask(mp.publicKey),
    accessToken: mask(mp.accessToken),
    clientId: mp.clientId ? mask(mp.clientId) : '(vazio)',
    clientSecret: mp.clientSecret ? '(definido)' : '(vazio)',
    webhookSecret: mp.webhookSecret ? '(definido)' : '(vazio)',
  };
}

module.exports = { config, validate, summary };
