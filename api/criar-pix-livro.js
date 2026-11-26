import crypto from 'node:crypto';

function sendJson(res, status, payload) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  return res.status(status).json(payload);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return sendJson(res, 405, { error: 'Método não permitido.' });
  }

  const token = process.env.MP_ACCESS_TOKEN;
  if (!token) {
    return sendJson(res, 503, { error: 'A integração de pagamento ainda não está configurada. Entre em contato com o suporte.' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = null; }
  }

  const nome = typeof body?.nome === 'string' ? body.nome.trim() : '';
  const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';

  if (nome.length < 2 || nome.length > 100 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 150) {
    return sendJson(res, 400, { error: 'Informe um nome e um e-mail válidos.' });
  }

  const orderId = 'LIVRO-' + crypto.randomUUID();

  try {
    const response = await fetch('https://api.mercadopago.com/v1/payments', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json',
        'X-Idempotency-Key': orderId
      },
      body: JSON.stringify({
        transaction_amount: 14.90,
        description: 'Uma Jornada Cósmica - livro digital PDF',
        payment_method_id: 'pix',
        external_reference: orderId,
        notification_url: 'https://umajornadacosmica.com.br/api/webhook-livro',
        payer: { email, first_name: nome.slice(0, 80) },
        metadata: { produto: 'uma_jornada_cosmica', nome, email, versao: '2' }
      })
    });

    const raw = await response.text();
    let data;
    try { data = raw ? JSON.parse(raw) : {}; } catch { data = {}; }

    if (!response.ok) {
      console.error('[criar-pix-livro] Mercado Pago recusou a solicitação:', response.status, data.message || data.error || 'resposta não detalhada');
      return sendJson(res, 502, { error: 'O Mercado Pago não conseguiu gerar o Pix. Confira os dados e tente novamente.' });
    }

    const pix = data.point_of_interaction?.transaction_data;
    if (!data.id || !pix?.qr_code || !pix?.qr_code_base64) {
      console.error('[criar-pix-livro] Resposta sem dados completos do Pix.');
      return sendJson(res, 502, { error: 'O Mercado Pago não retornou os dados do QR Code. Tente novamente mais tarde.' });
    }

    return sendJson(res, 200, {
      payment_id: String(data.id),
      qr_code: pix.qr_code,
      qr_code_base64: pix.qr_code_base64
    });
  } catch (error) {
    console.error('[criar-pix-livro] Falha de comunicação:', error?.message || error);
    return sendJson(res, 502, { error: 'Não foi possível comunicar com o serviço de pagamento. Tente novamente em instantes.' });
  }
}