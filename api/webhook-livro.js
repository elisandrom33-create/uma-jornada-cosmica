import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

function sendJson(res, status, payload) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  return res.status(status).json(payload);
}

function validarAssinatura(req, secret) {
  const signature = req.headers['x-signature'];
  const requestId = req.headers['x-request-id'];
  const dataId = req.query?.['data.id'];
  if (!signature || !requestId || !dataId || !secret) return false;

  const parts = Object.fromEntries(signature.split(',').map(part => {
    const [key, ...value] = part.trim().split('=');
    return [key, value.join('=')];
  }));
  if (!parts.ts || !parts.v1 || !/^[a-f0-9]{64}$/i.test(parts.v1)) return false;

  const manifest = 'id:' + String(dataId).toLowerCase() + ';request-id:' + requestId + ';ts:' + parts.ts + ';';
  const expected = crypto.createHmac('sha256', secret).update(manifest).digest();
  const received = Buffer.from(parts.v1, 'hex');
  return received.length === expected.length && crypto.timingSafeEqual(expected, received);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[char]);
}

async function enviarLivro({ supabase, bucket, paymentId, nome, email, resendKey }) {
  const { data: file, error: downloadError } = await supabase.storage.from(bucket).download('umajornadacosmica.pdf');
  if (downloadError || !file) throw new Error('Não foi possível baixar o PDF do armazenamento.');
  const buffer = Buffer.from(await file.arrayBuffer());
  if (buffer.subarray(0, 5).toString() !== '%PDF-') throw new Error('O arquivo armazenado não é um PDF válido.');

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + resendKey,
      'Content-Type': 'application/json',
      'Idempotency-Key': 'livro-' + paymentId
    },
    body: JSON.stringify({
      from: 'Uma Jornada Cósmica <contato@umajornadacosmica.com.br>',
      to: [email],
      subject: 'Seu livro Uma Jornada Cósmica chegou!',
      html: '<div style="font-family:Arial,sans-serif;color:#172033"><h2>Olá, ' + escapeHtml(nome) + '!</h2><p>Seu pagamento foi confirmado.</p><p>Obrigado por adquirir <strong>Uma Jornada Cósmica</strong>.</p><p>Seu livro digital está em anexo.</p><p>Boa leitura!</p></div>',
      attachments: [{ filename: 'Uma_Jornada_Cosmica.pdf', content: buffer.toString('base64') }]
    })
  });

  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.message || 'Falha no envio do e-mail.');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return sendJson(res, 405, { error: 'Método não permitido.' });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const mpToken = process.env.MP_ACCESS_TOKEN;
  const mpSecret = process.env.MP_WEBHOOK_SECRET;
  const resendKey = process.env.RESEND_API_KEY;
  const bucket = process.env.SUPABASE_BUCKET || 'livro-pdf';

  if (!supabaseUrl || !serviceKey || !mpToken || !mpSecret || !resendKey) {
    console.error('[webhook-livro] Variáveis de ambiente incompletas.');
    return sendJson(res, 503, { error: 'Integração de entrega não configurada.' });
  }

  if (!validarAssinatura(req, mpSecret)) return sendJson(res, 401, { error: 'Assinatura do webhook inválida.' });

  const paymentId = String(req.query?.['data.id'] || '');
  if (!/^\d{5,}$/.test(paymentId)) return sendJson(res, 400, { error: 'Pagamento inválido.' });

  const supabase = createClient(supabaseUrl, serviceKey);

  try {
    const paymentResponse = await fetch('https://api.mercadopago.com/v1/payments/' + encodeURIComponent(paymentId), {
      headers: { Authorization: 'Bearer ' + mpToken }
    });
    const payment = await paymentResponse.json().catch(() => ({}));
    if (!paymentResponse.ok) throw new Error('Não foi possível consultar o pagamento.');

    if (payment.status !== 'approved' ||
        payment.external_reference?.startsWith('LIVRO-') !== true ||
        Number(payment.transaction_amount) !== 0.10 ||
        payment.currency_id !== 'BRL' ||
        payment.metadata?.produto !== 'uma_jornada_cosmica') {
      return sendJson(res, 200, { received: true, ignored: true });
    }

    const nome = String(payment.metadata?.nome || payment.payer?.first_name || 'Leitor').trim();
    const email = String(payment.metadata?.email || payment.payer?.email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('E-mail do comprador inválido.');

    const { data: existing, error: readError } = await supabase
      .from('entregas_livro').select('status, updated_at').eq('payment_id', paymentId).maybeSingle();
    if (readError) throw readError;

    if (existing?.status === 'enviado') return sendJson(res, 200, { received: true, delivery: 'already_sent' });
    if (existing?.status === 'enviando' && existing.updated_at &&
        Date.now() - new Date(existing.updated_at).getTime() < 5 * 60 * 1000) {
      return sendJson(res, 200, { received: true, delivery: 'processing' });
    }

    const now = new Date().toISOString();
    if (!existing) {
      const { error } = await supabase.from('entregas_livro').insert({
        payment_id: paymentId, email, nome, status: 'enviando', created_at: now, updated_at: now
      });
      if (error) {
        if (error.code === '23505') return sendJson(res, 200, { received: true, delivery: 'processing' });
        throw error;
      }
    } else {
      let update = supabase.from('entregas_livro').update({
        email, nome, status: 'enviando', erro: null, updated_at: now
      }).eq('payment_id', paymentId);

      if (existing.status === 'enviando') {
        update = update.lt('updated_at', new Date(Date.now() - 5 * 60 * 1000).toISOString());
      } else {
        update = update.eq('status', 'falhou');
      }

      const { data, error } = await update.select('payment_id');
      if (error) throw error;
      if (!data?.length) return sendJson(res, 200, { received: true, delivery: 'processing' });
    }

    try {
      await enviarLivro({ supabase, bucket, paymentId, nome, email, resendKey });
      const sentAt = new Date().toISOString();
      const { error } = await supabase.from('entregas_livro').update({
        status: 'enviado', erro: null, sent_at: sentAt, updated_at: sentAt
      }).eq('payment_id', paymentId);
      if (error) throw error;
      console.log('[webhook-livro] Entrega concluída:', paymentId);
      return sendJson(res, 200, { received: true, delivery: 'sent' });
    } catch (error) {
      await supabase.from('entregas_livro').update({
        status: 'falhou', erro: String(error.message).slice(0, 1000), updated_at: new Date().toISOString()
      }).eq('payment_id', paymentId);
      throw error;
    }
  } catch (error) {
    console.error('[webhook-livro] Falha:', error?.message || error);
    return sendJson(res, 500, { error: 'Falha ao processar a entrega do livro.' });
  }
}