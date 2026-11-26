import { randomUUID } from 'crypto';

const MP_TOKEN = process.env.MP_ACCESS_TOKEN;
const NOTIFICATION_URL = 'https://umajornadacosmica.com.br/api/webhook-livro';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido.' });
  }

  if (!MP_TOKEN) {
    return res.status(503).json({
      error: 'MP_ACCESS_TOKEN não configurado na Vercel.'
    });
  }

  const nome = String(req.body?.nome || '').trim();
  const email = String(req.body?.email || '').trim().toLowerCase();

  if (nome.length < 2 || nome.length > 100) {
    return res.status(400).json({ error: 'Informe um nome válido.' });
  }

  if (
    email.length > 150 ||
    !/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email)
  ) {
    return res.status(400).json({ error: 'Informe um e-mail válido.' });
  }

  const idempotencyKey = randomUUID();
  const externalReference = 'LIVRO-' + randomUUID();

  try {
    const response = await fetch('https://api.mercadopago.com/v1/payments', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + MP_TOKEN,
        'Content-Type': 'application/json',
        'X-Idempotency-Key': idempotencyKey
      },
      body: JSON.stringify({
        transaction_amount: 14.90,
        description: 'Uma Jornada Cósmica - Livro digital',
        payment_method_id: 'pix',
        payer: {
          email,
          first_name: nome
        },
        external_reference: externalReference,
        notification_url: NOTIFICATION_URL,
        metadata: {
          produto: 'uma_jornada_cosmica',
          nome,
          email
        }
      })
    });

    const payment = await response.json();

    if (!response.ok) {
      console.error('[criar-pix-livro] Mercado Pago:', payment);
      return res.status(502).json({
        error: payment.message || 'O Mercado Pago não conseguiu gerar o Pix.'
      });
    }

    const pix = payment.point_of_interaction?.transaction_data;

    if (!payment.id || !pix?.qr_code || !pix?.qr_code_base64) {
      console.error('[criar-pix-livro] Resposta incompleta:', payment);
      return res.status(502).json({
        error: 'O Mercado Pago não retornou os dados completos do Pix.'
      });
    }

    return res.status(200).json({
      payment_id: String(payment.id),
      qr_code: pix.qr_code,
      qr_code_base64: pix.qr_code_base64
    });
  } catch (error) {
    console.error('[criar-pix-livro] Falha:', error?.message || error);
    return res.status(500).json({
      error: 'Falha interna ao gerar o Pix.'
    });
  }
}
