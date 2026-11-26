import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const MP_TOKEN = process.env.MP_ACCESS_TOKEN;
const MP_SECRET = process.env.MP_WEBHOOK_SECRET;
const RESEND_KEY = process.env.RESEND_API_KEY;
const BUCKET = process.env.SUPABASE_BUCKET || 'livro-pdf';
const PDF_FILE = 'umajornadacosmica.pdf';

function validarAssinatura(req) {
  const signature = req.headers['x-signature'];
  const requestId = req.headers['x-request-id'];
  const dataId = req.query['data.id'];

  if (!signature || !requestId || !dataId || !MP_SECRET) {
    return false;
  }

  const parts = Object.fromEntries(
    signature.split(',').map(part => {
      const [key, ...value] = part.trim().split('=');
      return [key, value.join('=')];
    })
  );

  if (!parts.ts || !parts.v1) return false;

  const manifest =
    `id:${String(dataId).toLowerCase()};` +
    `request-id:${requestId};` +
    `ts:${parts.ts};`;

  const calculated = crypto
    .createHmac('sha256', MP_SECRET)
    .update(manifest)
    .digest('hex');

  const received = parts.v1;

  if (!/^[a-f0-9]{64}$/i.test(received)) return false;

  return crypto.timingSafeEqual(
    Buffer.from(calculated, 'hex'),
    Buffer.from(received, 'hex')
  );
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[char]);
}

async function consultarPagamento(paymentId) {
  const response = await fetch(
    `https://api.mercadopago.com/v1/payments/${encodeURIComponent(paymentId)}`,
    {
      headers: {
        Authorization: `Bearer ${MP_TOKEN}`
      }
    }
  );

  const payment = await response.json();

  if (!response.ok) {
    throw new Error('Não foi possível consultar o pagamento.');
  }

  return payment;
}

async function enviarLivro(paymentId, nome, email) {
  const { data: file, error: downloadError } = await supabase
    .storage
    .from(BUCKET)
    .download(PDF_FILE);

  if (downloadError || !file) {
    throw new Error('Não foi possível baixar o PDF do Supabase.');
  }

  const buffer = Buffer.from(await file.arrayBuffer());

  if (buffer.subarray(0, 5).toString() !== '%PDF-') {
    throw new Error('O arquivo armazenado não é um PDF válido.');
  }

  const nomeSeguro = escapeHtml(nome);

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_KEY}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': `livro-${paymentId}`
    },
    body: JSON.stringify({
      from: 'Uma Jornada Cósmica <contato@umajornadacosmica.com.br>',
      to: [email],
      subject: 'Seu livro Uma Jornada Cósmica chegou!',
      html: `
        <div style="font-family:Arial,sans-serif;color:#172033">
          <h2>Olá, ${nomeSeguro}!</h2>
          <p>Seu pagamento foi confirmado.</p>
          <p>Obrigado por adquirir <strong>Uma Jornada Cósmica</strong>.</p>
          <p>Seu livro digital está em anexo.</p>
          <p>Boa leitura!</p>
        </div>
      `,
      attachments: [
        {
          filename: 'Uma_Jornada_Cosmica.pdf',
          content: buffer.toString('base64')
        }
      ]
    })
  });

  const result = await response.json();

  if (!response.ok) {
    throw new Error(result.message || 'Falha no envio do e-mail.');
  }

  return result;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido.' });
  }

  if (!MP_TOKEN || !MP_SECRET || !RESEND_KEY ||
      !process.env.SUPABASE_URL ||
      !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(503).json({
      error: 'Integração incompleta nas variáveis de ambiente.'
    });
  }

  if (!validarAssinatura(req)) {
    return res.status(401).json({
      error: 'Assinatura do webhook inválida.'
    });
  }

  const paymentId = String(req.query['data.id'] || '');

  if (!/^\d{5,}$/.test(paymentId)) {
    return res.status(400).json({ error: 'Pagamento inválido.' });
  }

  try {
    const payment = await consultarPagamento(paymentId);

    if (
      payment.status !== 'approved' ||
      payment.external_reference?.startsWith('LIVRO-') !== true ||
      Number(payment.transaction_amount) !== 14.90 ||
      payment.currency_id !== 'BRL' ||
      payment.metadata?.produto !== 'uma_jornada_cosmica'
    ) {
      return res.status(200).json({
        received: true,
        ignored: true
      });
    }

    const nome = String(
      payment.metadata?.nome ||
      payment.payer?.first_name ||
      'Leitor'
    ).trim();

    const email = String(
      payment.metadata?.email ||
      payment.payer?.email ||
      ''
    ).trim().toLowerCase();

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new Error('E-mail do comprador inválido.');
    }

    const { data: existing, error: readError } = await supabase
      .from('entregas_livro')
      .select('status, updated_at')
      .eq('payment_id', paymentId)
      .maybeSingle();

    if (readError) throw readError;

    if (existing?.status === 'enviado') {
      return res.status(200).json({
        received: true,
        delivery: 'already_sent'
      });
    }

    if (
      existing?.status === 'enviando' &&
      existing.updated_at &&
      Date.now() - new Date(existing.updated_at).getTime() < 5 * 60 * 1000
    ) {
      return res.status(200).json({
        received: true,
        delivery: 'processing'
      });
    }

    const now = new Date().toISOString();

    if (!existing) {
      const { error } = await supabase
        .from('entregas_livro')
        .insert({
          payment_id: paymentId,
          email,
          nome,
          status: 'enviando',
          created_at: now,
          updated_at: now
        });

      if (error) {
        if (error.code === '23505') {
          return res.status(200).json({
            received: true,
            delivery: 'processing'
          });
        }
        throw error;
      }
    } else {
      let update = supabase
        .from('entregas_livro')
        .update({
          email,
          nome,
          status: 'enviando',
          erro: null,
          updated_at: now
        })
        .eq('payment_id', paymentId);

      if (existing.status === 'enviando') {
        const staleBefore = new Date(
          Date.now() - 5 * 60 * 1000
        ).toISOString();

        update = update.lt('updated_at', staleBefore);
      } else {
        update = update.eq('status', 'falhou');
      }

      const { data, error } = await update.select('payment_id');

      if (error) throw error;

      if (!data || data.length === 0) {
        return res.status(200).json({
          received: true,
          delivery: 'processing'
        });
      }
    }

    try {
      await enviarLivro(paymentId, nome, email);

      const { error } = await supabase
        .from('entregas_livro')
        .update({
          status: 'enviado',
          erro: null,
          sent_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        })
        .eq('payment_id', paymentId);

      if (error) throw error;

      console.log('[webhook-livro] Entrega concluída:', paymentId);

      return res.status(200).json({
        received: true,
        delivery: 'sent'
      });

    } catch (error) {
      await supabase
        .from('entregas_livro')
        .update({
          status: 'falhou',
          erro: String(error.message).slice(0, 1000),
          updated_at: new Date().toISOString()
        })
        .eq('payment_id', paymentId);

      throw error;
    }

  } catch (error) {
    console.error('[webhook-livro] Falha:', error.message);

    return res.status(500).json({
      error: 'Falha ao processar a entrega do livro.'
    });
  }
}
