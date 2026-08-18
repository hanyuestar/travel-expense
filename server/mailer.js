/* 邮箱服务器配置：nodemailer 发验证码 / 邮件 */
'use strict';
const nodemailer = require('nodemailer');
const config = require('./config');
const dbModule = require('./db');
const db = () => dbModule.db;

function getConfig() {
  return db().prepare('SELECT * FROM email_config WHERE id = 1').get() || {};
}

function transporter(cfg) {
  return nodemailer.createTransport({
    host: cfg.smtp_host,
    port: cfg.smtp_port,
    secure: !!cfg.smtp_secure, // true => 465 SSL；false => 587 STARTTLS
    auth: cfg.smtp_user ? { user: cfg.smtp_user, pass: cfg.smtp_pass } : undefined,
    tls: { rejectUnauthorized: true }
  });
}

async function sendMail({ to, subject, text, html }) {
  const cfg = getConfig();
  if (!cfg || !cfg.enabled || !cfg.smtp_host) throw new Error('邮件服务未配置');
  const from = cfg.from_address || cfg.smtp_user || 'no-reply';
  const t = transporter(cfg);
  await t.sendMail({ from: `"${cfg.from_name || '旅行经费工作台'}" <${from}>`, to, subject, text, html });
}

async function sendVerificationCode(to, code, purpose) {
  const title = purpose === 'login' ? '登录' : '注册';
  const subject = `旅行经费工作台 — ${title}验证码`;
  const text = `您的${title}验证码为：${code}，${Math.round(config.CODE_TTL_MS / 60000)} 分钟内有效。如非本人操作请忽略。`;
  await sendMail({ to, subject, text });
}

module.exports = { sendMail, sendVerificationCode, getConfig };