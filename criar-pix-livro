import crypto from 'crypto';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido' });
  }

  const token = process.env.MP_ACCESS_TOKEN;
  if (!token) {
    return res.status(503).json({
      error: 'Integração pendente: configure MP_ACCESS_TOKEN nas variáveis de ambiente deste projeto Vercel.'
    });
  }

  const { nome, email } = req.body || {};
  if (
    typeof nome !== 'string' ||
    nome.trim().length < 2 ||
    typeof email !== 'string' ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())
  ) {
    return res.status(400).json({ error: 'Informe nome e e-mail válidos.' });
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
        payer: {
          email: email.trim(),
          first_name: nome.trim().slice(0, 80)
        },
        metadata: {
          produto: 'uma_jornada_cosmica',
          nome: nome.trim(),
          email: email.trim(),
          versao: '1'
        }
      })
    });

    const data = await response.json();
    if (!response.ok) {
      console.error('[criar-pix-livro] Mercado Pago:', {
        status: response.status,
        message: data.message || null
      });
      return res.status(400).json({
        error: data.message || 'Mercado Pago não conseguiu gerar o Pix.'
      });
    }

    const pix = data.point_of_interaction?.transaction_data;
    if (!pix?.qr_code || !pix?.qr_code_base64) {
      return res.status(502).json({
        error: 'O Mercado Pago não retornou os dados do QR Code.'
      });
    }

    return res.status(200).json({
      payment_id: String(data.id),
      qr_code: pix.qr_code,
      qr_code_base64: pix.qr_code_base64
    });
  } catch (error) {
    console.error('[criar-pix-livro] Falha:', error?.message || error);
    return res.status(500).json({
      error: 'Falha ao comunicar com o Mercado Pago.'
    });
  }
}
