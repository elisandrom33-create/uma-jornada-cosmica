(() => {
  const form = document.getElementById('purchase-form');
  if (!form) return;

  const payButton = document.getElementById('pay-button');
  const formMessage = document.getElementById('form-message');
  const pixPanel = document.getElementById('pix-panel');
  const pixQr = document.getElementById('pix-qr');
  const pixCode = document.getElementById('pix-code');
  const paymentStatus = document.getElementById('payment-status');
  const copyButton = document.getElementById('copy-pix');

  let paymentId = null;
  let buyerEmail = '';
  let pollTimer = null;
  let checking = false;

  async function requestJson(url, options) {
    const response = await fetch(url, options);
    const raw = await response.text();
    let data;

    try {
      data = raw ? JSON.parse(raw) : {};
    } catch {
      throw new Error(response.ok
        ? 'O servidor respondeu em um formato inesperado. Tente novamente em instantes.'
        : 'O serviço de pagamento está temporariamente indisponível. Tente novamente em alguns minutos.');
    }

    if (!response.ok) {
      throw new Error(data.error || 'Não foi possível concluir a solicitação.');
    }
    return data;
  }

  function showStatus(message, state) {
    paymentStatus.textContent = message;
    paymentStatus.dataset.state = state || 'pending';
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    formMessage.textContent = '';

    if (!form.reportValidity()) return;

    const nome = document.getElementById('buyer-name').value.trim();
    buyerEmail = document.getElementById('buyer-email').value.trim();

    payButton.disabled = true;
    payButton.textContent = 'Gerando Pix…';

    try {
      const data = await requestJson('/api/criar-pix-livro', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ nome, email: buyerEmail })
      });

      if (!data.payment_id || !data.qr_code || !data.qr_code_base64) {
        throw new Error('O pagamento foi iniciado, mas o QR Code não foi retornado. Entre em contato com o suporte antes de tentar novamente.');
      }

      paymentId = String(data.payment_id);
      pixCode.value = data.qr_code;
      pixQr.src = 'data:image/png;base64,' + data.qr_code_base64;
      pixPanel.hidden = false;
      showStatus('Aguardando confirmação do pagamento…', 'pending');
      pixPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

      if (pollTimer) window.clearInterval(pollTimer);
      pollTimer = window.setInterval(checkPayment, 5000);
      checkPayment();
    } catch (error) {
      formMessage.textContent = error.message || 'Não foi possível gerar o Pix. Tente novamente.';
    } finally {
      payButton.disabled = false;
      payButton.innerHTML = 'Gerar Pix de R$ 0,10 <span aria-hidden="true">→</span>';
    }
  });

  async function checkPayment() {
    if (!paymentId || checking) return;
    checking = true;

    try {
      const data = await requestJson('/api/status-pix-livro?payment_id=' + encodeURIComponent(paymentId));

      if (data.status === 'approved' && data.delivery_status === 'enviado') {
        window.clearInterval(pollTimer);
        showStatus('Pagamento confirmado! O livro foi enviado para ' + buyerEmail + '. Confira também a caixa de spam.', 'success');
      } else if (data.status === 'approved' && data.delivery_status === 'falhou') {
        window.clearInterval(pollTimer);
        showStatus('Pagamento confirmado, mas o envio do e-mail precisa de atendimento. Escreva para contato@umajornadacosmica.com.br.', 'error');
      } else if (data.status === 'approved') {
        showStatus('Pagamento confirmado! Estamos preparando o envio do seu livro…', 'pending');
      } else if (data.status === 'rejected' || data.status === 'cancelled') {
        window.clearInterval(pollTimer);
        showStatus('O pagamento não foi aprovado. Se desejar, gere um novo Pix.', 'error');
      } else {
        showStatus('Pix gerado. Aguardando a confirmação do banco…', 'pending');
      }
    } catch {
      showStatus('Não foi possível atualizar o status agora. Vamos tentar novamente automaticamente.', 'pending');
    } finally {
      checking = false;
    }
  }

  copyButton.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(pixCode.value);
      copyButton.textContent = 'Código copiado!';
    } catch {
      pixCode.focus();
      pixCode.select();
      showStatus('Selecione e copie o código Pix manualmente.', 'pending');
    }
  });
})();