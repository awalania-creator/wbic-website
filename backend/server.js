require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const nodemailer = require('nodemailer');
const axios = require('axios');
const Joi = require('joi');

const app = express();
const PORT = process.env.PORT || 3000;

// De app draait achter twee proxies: traefik-wbic (TLS) en nginx in wbic-web.
// Met 2 hops is req.ip het echte bezoekers-IP; een door de client meegestuurde
// X-Forwarded-For-waarde links daarvan wordt genegeerd. Nodig voor een eerlijke
// rate-limit per bezoeker (anders deelt iedereen één teller).
app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS || 2));

app.use(express.json({ limit: '20kb' }));

const ALLOWED_ORIGINS = [
  'https://wbic.nl',
  'https://www.wbic.nl',
  'https://wbic.aiwbic.cloud',
  /^http:\/\/localhost(:\d+)?$/
];

const corsOptions = {
  origin: function (origin, callback) {
    if (!origin || ALLOWED_ORIGINS.some(allowed => {
      if (typeof allowed === 'string') return origin === allowed;
      return allowed.test(origin);
    })) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  optionsSuccessStatus: 200
};
app.use(cors(corsOptions));

const limiter = rateLimit({
  windowMs: 10 * 60 * 1000, max: 5,
  message: 'Too many requests. Please try again later.',
  standardHeaders: true, legacyHeaders: false,
  skip: (req) => req.path === '/health'
});
app.use('/api/', limiter);

// Geen regeleinden in velden die in een mailheader belanden (onderwerp,
// Reply-To) of in de eerste regels van de tekst (naam): voorkomt header-injectie.
const ENKELE_REGEL = /^[^\r\n]*$/;

const contactSchema = Joi.object({
  naam: Joi.string().trim().min(3).max(100).pattern(ENKELE_REGEL).required(),
  email: Joi.string().trim().email().max(150).pattern(ENKELE_REGEL).required(),
  bedrijf: Joi.string().trim().allow('').max(150).pattern(ENKELE_REGEL).optional(),
  onderwerp: Joi.string().trim().min(1).max(200).pattern(ENKELE_REGEL).required(),
  bericht: Joi.string().trim().min(20).max(5000).required(),
  website: Joi.string().allow('').max(300).optional(),
  captchaToken: Joi.string().max(4096).required()
});

const TRIVIAL_BLOCKLIST = ['hello world','hi','hallo','123','asdf','qwerty','lorem ipsum'];
function isTrivialMessage(bericht) {
  const n = (bericht || '').trim().toLowerCase();
  if (!n) return true;
  return TRIVIAL_BLOCKLIST.some(p => n === p || n.startsWith(p));
}

// Mailroute uit de omgeving, geen waarden in de code. Standaard:
// Google Workspace SMTP-relay op 587 met verplichte STARTTLS. Gebruikersnaam en
// wachtwoord zijn optioneel (alleen voor route smtp.gmail.com + app-wachtwoord).
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_SECURE = String(process.env.SMTP_SECURE || 'false') === 'true';
const MAIL_FROM = process.env.SMTP_FROM || '"WBIC" <noreply@wbic.nl>';
const MAIL_TO = process.env.SMTP_TO || 'info@wbic.nl';

const transportConfig = {
  host: process.env.SMTP_HOST || 'smtp-relay.gmail.com',
  port: SMTP_PORT,
  secure: SMTP_SECURE,
  requireTLS: !SMTP_SECURE,
  name: process.env.SMTP_HELO_NAME || 'wbic.nl',
  tls: { servername: process.env.SMTP_HOST || 'smtp-relay.gmail.com' },
  connectionTimeout: 15000,
  greetingTimeout: 15000,
  socketTimeout: 30000
};
if (process.env.SMTP_USER && process.env.SMTP_PASS) {
  transportConfig.auth = { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS };
}
const transporter = nodemailer.createTransport(transportConfig);

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.post('/api/contact', async (req, res) => {
  try {
    // Honeypot: bots vullen het verborgen veld; doe alsof het gelukt is, verstuur niets.
    if (req.body && typeof req.body.website === 'string' && req.body.website.trim() !== '') {
      return res.status(200).json({ success: true, message: 'Email verzonden' });
    }
    const { error, value } = contactSchema.validate(req.body, { abortEarly: false });
    if (error) return res.status(400).json({ success: false, error: 'Controleer de velden: naam, e-mailadres, onderwerp en een bericht van minimaal 20 tekens.' });
    const { naam, email, bedrijf, onderwerp, bericht, captchaToken } = value;
    if (isTrivialMessage(bericht)) return res.status(400).json({ success: false, error: 'Bericht lijkt te kort.' });
    try {
      const cr = await axios.post('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
        secret: process.env.CLOUDFLARE_TURNSTILE_SECRET || process.env.TURNSTILE_SECRET,
        response: captchaToken,
        remoteip: req.ip
      }, { timeout: 10000 });
      if (!cr.data.success) return res.status(403).json({ success: false, error: 'CAPTCHA verification failed' });
    } catch (e) { return res.status(403).json({ success: false, error: 'CAPTCHA verification failed' }); }
    try {
      // Alleen platte tekst (geen HTML-deel), dus geen HTML-escaping nodig;
      // nodemailer codeert de headers. Reply-To is het gevalideerde adres.
      await transporter.sendMail({
        from: MAIL_FROM,
        to: MAIL_TO,
        replyTo: { name: naam, address: email },
        subject: `Contact: ${onderwerp}`,
        text: `Naam: ${naam}\nE-mail: ${email}\nBedrijf: ${bedrijf || '-'}\n\n${bericht}`
      });
      return res.status(200).json({ success: true, message: 'Email verzonden' });
    } catch (e) {
      // Geen inhoud of adressen loggen; alleen de foutcode voor diagnose.
      console.error('sendMail mislukt:', e && (e.code || e.responseCode || e.name));
      return res.status(502).json({ success: false, error: 'Verzenden is niet gelukt. Probeer het later opnieuw of mail info@wbic.nl.' });
    }
  } catch (err) { return res.status(500).json({ success: false, error: 'Internal server error' }); }
});

app.use((req, res) => res.status(404).json({ success: false, error: 'Not Found' }));
app.use((err, req, res, next) => {
  if (err && err.message === 'Not allowed by CORS') return res.status(403).json({ success: false, error: 'Origin not allowed' });
  if (err && err.type === 'entity.too.large') return res.status(413).json({ success: false, error: 'Payload too large' });
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ success: false, error: 'Invalid JSON' });
  return res.status(500).json({ success: false, error: 'Internal server error' });
});

if (require.main === module) {
  app.listen(PORT, () => console.log(`WBIC Contact API listening on port ${PORT}`));
}
module.exports = { app, contactSchema, transportConfig };
