const path = require('path');
const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const { Resend } = require('resend');

dotenv.config();

const app = express();
const port = process.env.PORT || 4000;
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'http://localhost:8000').split(',').map(value => value.trim());

app.use(cors({
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
      return;
    }

    callback(new Error('Origin not allowed by CORS'));
  }
}));

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'Index.html'));
});

function formatMoney(value) {
  return `R${Number(value || 0).toLocaleString()}`;
}

function getProductList(items) {
  if (!Array.isArray(items) || items.length === 0) return 'No items selected';

  return items.map((item) => {
    const itemName = item.name || 'Product';
    const itemQty = item.qty || 1;
    const itemPrice = item.price || 0;
    const code = item.code || 'N/A';
    return `• ${itemName} (${code}) x${itemQty} — ${formatMoney(itemPrice * itemQty)}`;
  }).join('<br>');
}

async function sendEmail({ to, subject, html }) {
  if (!resend || !process.env.RESEND_API_KEY) {
    throw new Error('RESEND_API_KEY is missing. Add it to a .env file before sending emails.');
  }

  const fromAddress = process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev';

  const response = await resend.emails.send({
    from: `My Hair <${fromAddress}>`,
    to: Array.isArray(to) ? to : [to],
    subject,
    html
  });

  return response;
}

app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'myhair-store-backend' });
});

app.post('/api/test-email', async (req, res) => {
  try {
    const { buyerEmail, total = 0, items = [] } = req.body || {};

    if (!buyerEmail) {
      return res.status(400).json({ ok: false, error: 'buyerEmail is required' });
    }

    const result = await sendEmail({
      to: buyerEmail,
      subject: 'My Hair test email',
      html: `
        <h2>Test email from My Hair</h2>
        <p>This is a test message from the Resend integration.</p>
        <p>Total: ${formatMoney(total)}</p>
        <p>Items: ${getProductList(items)}</p>
      `
    });

    return res.json({ ok: true, result });
  } catch (error) {
    console.error('Test email failed:', error);
    return res.status(500).json({ ok: false, error: error.message });
  }
});

app.post('/api/order-email', async (req, res) => {
  try {
    const {
      buyerEmail,
      items = [],
      total = 0,
      fee = 0,
      payout = 0,
      productCode = 'N/A'
    } = req.body || {};

    if (!buyerEmail) {
      return res.status(400).json({ ok: false, error: 'buyerEmail is required' });
    }

    const html = `
      <h2>Thank you for your order from My Hair</h2>
      <p>Your payment was successful.</p>
      <p><strong>Product code:</strong> ${productCode}</p>
      <p><strong>Order:</strong><br>${getProductList(items)}</p>
      <p><strong>Total paid:</strong> ${formatMoney(total)}</p>
      <p><strong>Creator fee (5%):</strong> ${formatMoney(fee)}</p>
      <p><strong>Client payout (95%):</strong> ${formatMoney(payout)}</p>
      <p>We will be in touch shortly with the next steps.</p>
    `;

    const buyerResult = await sendEmail({
      to: buyerEmail,
      subject: `My Hair order confirmation - ${productCode}`,
      html
    });

    const sellerResult = await sendEmail({
      to: process.env.SELLER_EMAIL || '08myhair@gmail.com',
      subject: `New My Hair order - ${productCode}`,
      html: `
        <h2>New order received</h2>
        <p><strong>Buyer email:</strong> ${buyerEmail}</p>
        <p><strong>Product code:</strong> ${productCode}</p>
        <p><strong>Items:</strong><br>${getProductList(items)}</p>
        <p><strong>Total:</strong> ${formatMoney(total)}</p>
        <p><strong>Creator fee (5%):</strong> ${formatMoney(fee)}</p>
        <p><strong>Client payout (95%):</strong> ${formatMoney(payout)}</p>
      `
    });

    res.json({
      ok: true,
      buyerResult,
      sellerResult
    });
  } catch (error) {
    console.error('Order email failed:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post('/api/paypal-webhook', async (req, res) => {
  const payload = req.body || {};

  const eventType = payload.event_type || payload.eventType;

  if (process.env.NODE_ENV !== 'production' && req.query.mock === 'true') {
    const items = payload.items || [];
    const buyerEmail = payload.buyerEmail || 'buyer@example.com';
    const total = Number(payload.total || 0);
    const fee = Number(payload.fee || 0);
    const payout = Number(payload.payout || 0);
    const productCode = payload.productCode || 'N/A';

    try {
      const result = await sendEmail({
        to: buyerEmail,
        subject: `My Hair payment confirmed - ${productCode}`,
        html: `
          <h2>Payment confirmed</h2>
          <p>Thank you for your purchase.</p>
          <p><strong>Product code:</strong> ${productCode}</p>
          <p><strong>Total paid:</strong> ${formatMoney(total)}</p>
          <p><strong>Items:</strong><br>${getProductList(items)}</p>
        `
      });

      return res.status(200).json({ ok: true, eventType: 'mock-success', result });
    } catch (error) {
      console.error('Mock webhook email failed:', error);
      return res.status(500).json({ ok: false, error: error.message });
    }
  }

  if (eventType === 'CHECKOUT.ORDER.APPROVED' || eventType === 'PAYMENT.CAPTURE.COMPLETED') {
    try {
      const total = Number(payload.purchase_units?.[0]?.amount?.value || payload.amount || 0) * 100;
      const items = payload.items || [];
      const buyerEmail = payload.payer?.email_address || payload.buyerEmail || 'buyer@example.com';
      const productCode = payload.productCode || 'N/A';
      const fee = total * 0.05;
      const payout = total - fee;

      const result = await sendEmail({
        to: buyerEmail,
        subject: `My Hair order confirmation - ${productCode}`,
        html: `
          <h2>Payment confirmed</h2>
          <p>Thank you for your order.</p>
          <p><strong>Product code:</strong> ${productCode}</p>
          <p><strong>Items:</strong><br>${getProductList(items)}</p>
          <p><strong>Total paid:</strong> ${formatMoney(total)}</p>
          <p><strong>Creator fee (5%):</strong> ${formatMoney(fee)}</p>
          <p><strong>Client payout (95%):</strong> ${formatMoney(payout)}</p>
        `
      });

      return res.status(200).json({ ok: true, eventType, result });
    } catch (error) {
      console.error('Webhook email failed:', error);
      return res.status(500).json({ ok: false, error: error.message });
    }
  }

  return res.status(200).json({ ok: true, received: true, eventType: eventType || 'unknown' });
});

app.listen(port, () => {
  console.log(`My Hair backend listening on http://localhost:${port}`);
});
