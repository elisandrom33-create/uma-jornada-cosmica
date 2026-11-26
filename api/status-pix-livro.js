import { createClient } from '@supabase/supabase-js';

function sendJson(res, status, payload) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  return res.status(status).json(payload);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[char]);
}

async function entregarLivro({ supabase, bucket, paymentId, nome, email, resendKey }) {
  const { data: existing, error: readError } = await supabase
    .from('entregas_livro')
    .select('status, updated_at')
    .eq('payment_id', paymentId)
    .maybeSingle();
  if (readError) throw readError;

  if (existing?.status === 'enviado') return 'enviado';
  if (existing?.status === 'enviando' && existing.updated_at &&
      Date.now() - new Date(existing.updated_at).getTime() < 5 * 60 * 1000) {
    return 'enviando';
  }

  const now = new Date().toISOString();
  if (!existing) {
    const { error } = await supabase.from('entregas_livro').insert({
      payment_id: paymentId, email, nome, status: 'enviando', created_at: now, updated_at: now
    });
    if (error) {
      if (error.code === '23505') return 'enviando';
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
    if (!data?.length) return 'enviando';
  }

  try {
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

    const sentAt = new Date().toISOString();
    const { error } = await supabase.from('entregas_livro').update({
      status: 'enviado', erro: null, sent_at: sentAt, updated_at: sentAt
    }).eq('payment_id', paymentId);
    if (error) throw error;
    console.log('[status-pix-livro] Entrega concluída:', paymentId);
    return 'enviado';
  } catch (error) {
    await supabase.from('entregas_livro').update({
      status: 'falhou', erro: String(error.message).slice(0, 1000), updated_at: new Date().toISOString()
    }).eq('payment_id', paymentId);
    throw error;
  }
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return sendJson(res, 405, { error: 'Método não permitido.' });
  }

  const token = process.env.MP_ACCESS_TOKEN;
  if (!token) return sendJson(res, 503, { error: 'Serviço de pagamento não configurado.' });

  const id = String(req.query?.payment_id || '');
  if (!/^\d{5,}$/.test(id)) return sendJson(res, 400, { error: 'Identificador de pagamento inválido.' });

  try {
    const response = await fetch('https://api.mercadopago.com/v1/payments/' + encodeURIComponent(id), {
      headers: { Authorization: 'Bearer ' + token }
    });
    const payment = await response.json().catch(() => ({}));

    if (!response.ok) return sendJson(res, 404, { error: 'Pagamento não encontrado.' });

    if (payment.external_reference?.startsWith('LIVRO-') !== true ||
        Number(payment.transaction_amount) !== 0.10 ||
        payment.currency_id !== 'BRL' ||
        payment.metadata?.produto !== 'uma_jornada_cosmica') {
      return sendJson(res, 403, { error: 'Este pagamento não pertence a esta compra.' });
    }

    let deliveryStatus = null;
    const supabaseUrl = process.env.SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const resendKey = process.env.RESEND_API_KEY;

    if (payment.status === 'approved' && supabaseUrl && serviceKey && resendKey) {
      const supabase = createClient(supabaseUrl, serviceKey);
      const email = String(payment.metadata?.email || payment.payer?.email || '').trim().toLowerCase();
      const nome = String(payment.metadata?.nome || payment.payer?.first_name || 'Leitor').trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        throw new Error('E-mail do comprador inválido.');
      }
      deliveryStatus = await entregarLivro({
        supabase,
        bucket: process.env.SUPABASE_BUCKET || 'livro-pdf',
        paymentId: id,
        nome,
        email,
        resendKey
      });
    } else if (payment.status === 'approved' && (!supabaseUrl || !serviceKey || !resendKey)) {
      console.error('[status-pix-livro] Variáveis de entrega incompletas.');
      return sendJson(res, 503, { error: 'Integração de entrega não configurada.' });
    }

    return sendJson(res, 200, { status: payment.status, delivery_status: deliveryStatus });
  } catch (error) {
    console.error('[status-pix-livro] Falha:', error?.message || error);
    return sendJson(res, 502, { error: 'Não foi possível consultar ou entregar o livro neste momento.' });
  }
}