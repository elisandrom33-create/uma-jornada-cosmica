import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const mpToken = process.env.MP_ACCESS_TOKEN;

const supabase = supabaseUrl && supabaseServiceKey
  ? createClient(supabaseUrl, supabaseServiceKey)
  : null;

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Método não permitido' });
  }

  if (!mpToken) {
    return res.status(503).json({ error: 'MP_ACCESS_TOKEN não configurado.' });
  }

  const id = String(req.query.payment_id || '');
  if (!/^\d{5,}$/.test(id)) {
    return res.status(400).json({ error: 'Identificador de pagamento inválido.' });
  }

  try {
    const response = await fetch(
      'https://api.mercadopago.com/v1/payments/' + encodeURIComponent(id),
      { headers: { Authorization: 'Bearer ' + mpToken } }
    );

    const payment = await response.json();
    if (!response.ok) {
      return res.status(404).json({ error: 'Pagamento não encontrado.' });
    }

    if (
      payment.external_reference?.startsWith('LIVRO-') !== true ||
      Number(payment.transaction_amount) !== 14.90 ||
      payment.metadata?.produto !== 'uma_jornada_cosmica'
    ) {
      return res.status(403).json({
        error: 'Este pagamento não pertence a esta compra.'
      });
    }

    let deliveryStatus = null;

    if (payment.status === 'approved' && supabase) {
      const { data, error } = await supabase
        .from('entregas_livro')
        .select('status')
        .eq('payment_id', id)
        .maybeSingle();

      if (error) {
        console.error('[status-pix-livro] Supabase:', error.message);
      } else if (data) {
        deliveryStatus = data.status;
      }
    }

    return res.status(200).json({
      status: payment.status,
      delivery_status: deliveryStatus
    });
  } catch (error) {
    console.error('[status-pix-livro] Falha:', error?.message || error);
    return res.status(500).json({
      error: 'Falha ao consultar pagamento.'
    });
  }
}
