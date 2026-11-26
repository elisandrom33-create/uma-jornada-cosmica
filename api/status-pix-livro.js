import { createClient } from '@supabase/supabase-js';

function sendJson(res, status, payload) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  return res.status(status).json(payload);
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

    if (payment.status === 'approved' && supabaseUrl && serviceKey) {
      const supabase = createClient(supabaseUrl, serviceKey);
      const { data, error } = await supabase
        .from('entregas_livro')
        .select('status')
        .eq('payment_id', id)
        .maybeSingle();

      if (error) console.error('[status-pix-livro] Supabase:', error.message);
      else if (data) deliveryStatus = data.status;
    }

    return sendJson(res, 200, { status: payment.status, delivery_status: deliveryStatus });
  } catch (error) {
    console.error('[status-pix-livro] Falha:', error?.message || error);
    return sendJson(res, 502, { error: 'Não foi possível consultar o pagamento neste momento.' });
  }
}